// zip / unzip for file_manage: Python's zipfile, run under the same sandbox runner as the python tool
// (FOX_CONFINE_RUNNER, docker/fox-confine.sh) with the workspace as its only writable folder. The script does not
// trust that alone — with FOX_SANDBOX_MODE=none the runner confines nothing — so it never follows a link either:
// every folder is opened with O_NOFOLLOW from the workspace down and every file is created relative to its
// parent's descriptor with O_EXCL | O_NOFOLLOW (the same rule as safe-fs.ts).
// Both stream (1 MB at a time: memory stays small whatever the size) and leave nothing behind on failure: zip writes a
// hidden temporary archive renamed at the end, unzip removes the files it wrote. An entry that would land on an
// internal folder, an uploaded original or a canvas version name is refused, overwrite or not.
import { spawn } from 'node:child_process'

export const MAX_ENTRIES = 2000
export const MAX_BYTES = 500 * 1024 * 1024
const TIMEOUT_MS = 120_000

const SCRIPT = String.raw`
import errno, json, os, re, secrets, signal, stat, sys, time, zipfile


def _stopped(*_):
    # the host's timeout: unwind, so the partial output is removed, and report it
    raise ValueError("took too long and was stopped")


signal.signal(signal.SIGTERM, _stopped)

action, src, dst, overwrite = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
MAX_ENTRIES, MAX_BYTES = int(sys.argv[5]), int(sys.argv[6])
PROTECTED = set(json.loads(sys.argv[7]).get("sources", []))
CANVAS_VERSION = re.compile(r"^canvas-[a-z0-9][a-z0-9-]*-v\d+\.[^/]+$")
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
NEW = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
SKIP = {"__MACOSX", ".DS_Store"}
CHUNK = 1 << 20
MB = MAX_BYTES // (1024 * 1024)


def parts(rel):
    out = [p for p in rel.replace("\\", "/").split("/") if p not in ("", ".")]
    if ".." in out:
        raise ValueError(f"not inside the working directory: {rel}")
    return out


def open_dir(names, create=False):
    fd = os.open(".", DIR)
    for name in names:
        if create:
            try:
                os.mkdir(name, dir_fd=fd)
            except FileExistsError:
                pass
        nxt = os.open(name, DIR, dir_fd=fd)  # a link fails here (ELOOP), a file with ENOTDIR
        os.close(fd)
        fd = nxt
    return fd


def refuse_target(rel_parts):
    path = "/".join(rel_parts)
    if rel_parts and rel_parts[0] in (".fox", ".canvas"):
        raise ValueError(f"would write into an internal folder: {path}")
    if path in PROTECTED:
        raise ValueError(f"would replace a file the user uploaded: {path}")
    if rel_parts and CANVAS_VERSION.match(rel_parts[-1]):
        raise ValueError(f"would write a canvas version name: {path}")


def entry_name(info):
    name = info.filename
    if not (info.flag_bits & 0x800):  # no UTF-8 flag: zipfile decoded the name as cp437
        try:
            name = name.encode("cp437").decode("utf-8")  # Vietnamese names zipped on Windows
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return name


def unlink_in(folder, name):
    try:
        fd = open_dir(folder)
        try:
            os.unlink(name, dir_fd=fd)
        finally:
            os.close(fd)
    except OSError:
        pass


def unzip():
    src_parts = parts(src)
    fd = open_dir(src_parts[:-1])
    try:
        zfd = os.open(src_parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    finally:
        os.close(fd)
    dest = parts(dst)
    files = skipped = written = 0
    created = []  # (folder parts, name) of every file written: removed again if the unzip fails
    with os.fdopen(zfd, "rb") as raw, zipfile.ZipFile(raw) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            raise ValueError(f"the archive has {len(infos)} entries; at most {MAX_ENTRIES}")
        if sum(i.file_size for i in infos) > MAX_BYTES:
            raise ValueError(f"the archive unpacks to more than {MB} MB")
        try:
            for info in infos:
                name = entry_name(info)
                if name.startswith("/") or (len(name) > 1 and name[1] == ":"):
                    raise ValueError(f"unsafe entry (absolute path): {name}")
                rel = parts(name)  # ".." raises: zip-slip
                if not rel or any(p in SKIP for p in rel) or stat.S_ISLNK(info.external_attr >> 16):
                    skipped += 1  # never recreate a link
                    continue
                if info.is_dir():
                    os.close(open_dir(dest + rel, create=True))
                    continue
                refuse_target(dest + rel)
                pfd = open_dir(dest + rel[:-1], create=True)
                try:
                    if overwrite:
                        try:
                            st = os.stat(rel[-1], dir_fd=pfd, follow_symlinks=False)
                            if stat.S_ISDIR(st.st_mode):
                                raise ValueError(f"a folder is in the way: {'/'.join(dest + rel)}")
                            os.unlink(rel[-1], dir_fd=pfd)
                        except FileNotFoundError:
                            pass
                    try:
                        out = os.open(rel[-1], NEW, 0o644, dir_fd=pfd)
                    except FileExistsError:
                        raise ValueError(f"already exists: {'/'.join(dest + rel)} (pass overwrite: true to replace)")
                finally:
                    os.close(pfd)
                created.append((dest + rel[:-1], rel[-1]))
                with os.fdopen(out, "wb") as target, archive.open(info) as member:
                    while True:
                        chunk = member.read(CHUNK)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > MAX_BYTES:
                            raise ValueError(f"the archive unpacks to more than {MB} MB")
                        target.write(chunk)
                files += 1
        except BaseException:
            for folder, name in created:
                unlink_in(folder, name)
            raise
    return {"files": files, "skipped": skipped, "bytes": written}


def zip_():
    src_parts, dst_parts = parts(src), parts(dst)
    if not dst_parts:
        raise ValueError("zip needs a target file name")
    refuse_target(dst_parts)
    temporary = f".{dst_parts[-1]}.{secrets.token_hex(4)}.part"
    pfd = open_dir(dst_parts[:-1], create=True)
    out = os.open(temporary, NEW, 0o644, dir_fd=pfd)
    files = skipped = total = 0
    base = src_parts[-1] if src_parts else "files"
    try:
        with os.fdopen(out, "wb") as raw, zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED) as archive:
            def add_file(dir_fd, name, arc):
                nonlocal files, total
                if files >= MAX_ENTRIES:
                    raise ValueError(f"too much to zip: at most {MAX_ENTRIES} files")
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
                with os.fdopen(fd, "rb") as handle:
                    st = os.fstat(handle.fileno())
                    info = zipfile.ZipInfo(arc, time.localtime(st.st_mtime)[:6])
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with archive.open(info, "w", force_zip64=True) as member:
                        while True:
                            chunk = handle.read(CHUNK)
                            if not chunk:
                                break
                            total += len(chunk)
                            if total > MAX_BYTES:
                                raise ValueError(f"too much to zip: at most {MB} MB")
                            member.write(chunk)
                files += 1

            def walk(dir_fd, prefix, top):
                nonlocal skipped
                for name in sorted(os.listdir(dir_fd)):
                    if top and name in (".fox", ".canvas"):
                        continue
                    if name.endswith(".part") and name.startswith("."):
                        continue  # a temporary archive (this one included)
                    st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
                    if stat.S_ISDIR(st.st_mode):
                        sub = os.open(name, DIR, dir_fd=dir_fd)
                        try:
                            walk(sub, f"{prefix}/{name}", False)
                        finally:
                            os.close(sub)
                    elif stat.S_ISREG(st.st_mode):
                        add_file(dir_fd, name, f"{prefix}/{name}")
                    else:
                        skipped += 1  # links and special files are left out

            parent = open_dir(src_parts[:-1])
            try:
                st = os.stat(src_parts[-1], dir_fd=parent, follow_symlinks=False) if src_parts else os.stat(".")
                if stat.S_ISDIR(st.st_mode):
                    sub = os.open(src_parts[-1], DIR, dir_fd=parent) if src_parts else os.open(".", DIR)
                    try:
                        walk(sub, base, not src_parts)
                    finally:
                        os.close(sub)
                elif stat.S_ISREG(st.st_mode):
                    add_file(parent, src_parts[-1], base)
                else:
                    raise ValueError(f"not a file or folder: {src}")
            finally:
                os.close(parent)
        if not overwrite:
            try:
                os.stat(dst_parts[-1], dir_fd=pfd, follow_symlinks=False)
                raise ValueError(f"already exists: {dst} (pass overwrite: true to replace)")
            except FileNotFoundError:
                pass
        os.rename(temporary, dst_parts[-1], src_dir_fd=pfd, dst_dir_fd=pfd)  # replaces the entry, never a link's target
    except BaseException:
        try:
            os.unlink(temporary, dir_fd=pfd)
        except OSError:
            pass
        raise
    finally:
        os.close(pfd)
    return {"files": files, "skipped": skipped, "bytes": total}


try:
    result = unzip() if action == "unzip" else zip_()
    print(json.dumps({"ok": True, **result}))
except zipfile.BadZipFile:
    print(json.dumps({"ok": False, "error": f"{src} is not a valid zip file"}))
except (RuntimeError, NotImplementedError) as e:  # an encrypted entry, an unsupported compression (deflate64…)
    print(json.dumps({"ok": False, "error": f"cannot {action} {src}: {e}"}))
except FileNotFoundError as e:
    print(json.dumps({"ok": False, "error": f"not found: {e.filename or src}"}))
except OSError as e:
    reason = {errno.ELOOP: "a link is in the way (links are not followed)", errno.ENOTDIR: "a file is where a folder is expected"}.get(e.errno, e.strerror)
    print(json.dumps({"ok": False, "error": f"{reason}: {e.filename or src}"}))
except ValueError as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`

export interface ZipResult { files: number; skipped: number; bytes: number }

/** Runs zip / unzip in `cwd` (paths relative to it), under the sandbox runner when one is configured. */
export function runZip(
  action: 'zip' | 'unzip',
  cwd: string,
  src: string,
  dst: string,
  overwrite: boolean,
  protect: { sources: string[] },
  signal?: AbortSignal,
): Promise<ZipResult> {
  const python = globalThis.process.env.FOX_PYTHON || 'python3'
  const scriptArgs = [python, '-I', '-c', SCRIPT, action, src, dst, overwrite ? '1' : '0', String(MAX_ENTRIES), String(MAX_BYTES), JSON.stringify(protect)]
  const runner = globalThis.process.env.FOX_CONFINE_RUNNER
  // --tmpfs: fox-confine.sh's "write mode" — the workspace is bound read-write (and is the only writable folder).
  const [program, ...args] = runner ? [runner, '--ro-bind', '/', '/', '--bind', cwd, cwd, '--tmpfs', '/tmp', '--', ...scriptArgs] : scriptArgs
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program!, args, { cwd, env: { PATH: globalThis.process.env.PATH, LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let stdout = ''
    let stderr = ''
    // SIGTERM first: python unwinds and removes its partial output; SIGKILL if it does not stop
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-10_000) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code, killed) => {
      clearTimeout(timer)
      const line = stdout.trim().split('\n').pop() ?? ''
      try {
        const reply = JSON.parse(line) as { ok: boolean; error?: string } & ZipResult
        if (reply.ok) return resolvePromise({ files: reply.files, skipped: reply.skipped, bytes: reply.bytes })
        return reject(new Error(reply.error ?? `${action} failed`))
      } catch {
        if (killed !== null) return reject(new Error(`${action} took longer than ${TIMEOUT_MS / 1000} s and was stopped`))
        reject(new Error(`${action} failed: ${stderr.trim().split('\n').pop() || `exit ${String(code)}`}`))
      }
    })
  })
}
