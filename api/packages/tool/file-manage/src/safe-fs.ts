// A copy of services/gateway/src/runtime/safe-fs.ts — packages never import a service's code (docs/code-rules.md §1),
// so keep them in step. This copy adds the folder helpers at the end (listInside, statInside, mkdirInside, copyFileInside) for file_manage.
// docs/workspace-symlink-isolation-plan.md — file access inside a working directory that a symlink cannot redirect.
// The model's python runs sandboxed but can still make a symlink in its own folder (`env.txt -> /proc/self/environ`,
// `dir_link -> another user's folder`). This process runs outside that sandbox, so a plain `stat`/`readFile`/
// `createWriteStream`/`rm` on such a path reads, writes or deletes the real target. A path check before the open
// is not enough either: the python kernel lives on between calls and can swap a file for a link meanwhile.
//
// So every step goes through what is already open. On Linux, `/proc/self/fd/<n>/<name>` resolves <name> inside the
// directory open as <n>: the walk opens each directory with O_NOFOLLOW from the (real) root down, and the last
// component is opened, created (O_EXCL), renamed or removed relative to its parent's descriptor. No component can
// be a symlink, and nothing swapped after a check changes which directory is used.
// Elsewhere (a developer's macOS, where the strict sandbox never runs) each component is lstat-ed instead: it
// refuses a link already in place, not one swapped in between.
import { constants, existsSync, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = constants
const PROC_FD = existsSync('/proc/self/fd') ? '/proc/self/fd' : undefined

/** The path leaves the directory, goes through a symlink, or names something that is not a regular file. */
export class NotInsideError extends Error {}

/** Nothing usable there: missing, a link on the way (ELOOP), a file where a folder was expected. */
const missing = (error: unknown) => {
  if (error instanceof NotInsideError) return true
  const code = (error as { code?: string }).code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP'
}

function partsOf(rel: string): { dirs: string[]; name: string } {
  const parts = rel.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.includes('..')) throw new NotInsideError(`not a path inside the directory: ${rel}`)
  const name = parts.pop()!
  return { dirs: parts, name }
}

/** Calls `use` with a path to the directory `dirs` (from `root`) that no symlink can redirect; `create` makes missing ones. */
async function inDir<T>(root: string, dirs: string[], create: boolean, use: (dir: string) => Promise<T>): Promise<T> {
  if (!PROC_FD) {
    let dir = await realpath(root)
    for (const name of dirs) {
      dir = join(dir, name)
      if (create) await mkdir(dir).catch((error: { code?: string }) => { if (error.code !== 'EEXIST') throw error })
      if (!(await lstat(dir)).isDirectory()) throw new NotInsideError(`not a directory: ${name}`)
    }
    return use(dir)
  }
  let handle = await open(await realpath(root), O_RDONLY | O_DIRECTORY)
  try {
    for (const name of dirs) {
      const child = `${PROC_FD}/${handle.fd}/${name}`
      if (create) await mkdir(child).catch((error: { code?: string }) => { if (error.code !== 'EEXIST') throw error })
      // a symlink fails with ELOOP, a file with ENOTDIR
      const next = await open(child, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      await handle.close()
      handle = next
    }
    return await use(`${PROC_FD}/${handle.fd}`)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** An existing regular file at `rel` inside `root`, open for reading; undefined when there is none (or it is a link). */
export async function openInside(root: string, rel: string): Promise<{ handle: FileHandle; info: Stats } | undefined> {
  const { dirs, name } = partsOf(rel)
  try {
    return await inDir(root, dirs, false, async (dir) => {
      // O_NONBLOCK: a FIFO the model made must not hang the request at the open
      const handle = await open(join(dir, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      const info = await handle.stat()
      if (info.isFile()) return { handle, info }
      await handle.close()
      return undefined
    })
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/** A new file at `rel` inside `root` (missing directories made); fails when the name exists, a symlink included. */
export async function createInside(root: string, rel: string): Promise<FileHandle> {
  const { dirs, name } = partsOf(rel)
  return inDir(root, dirs, true, (dir) => open(join(dir, name), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644))
}

/** Renames `from` to `to`, both in the same directory inside `root`. Replaces `to` itself (never a link's target). */
export async function renameInside(root: string, from: string, to: string): Promise<void> {
  const source = partsOf(from)
  const target = partsOf(to)
  if (source.dirs.join('/') !== target.dirs.join('/')) throw new NotInsideError('rename across directories')
  await inDir(root, source.dirs, false, (dir) => rename(join(dir, source.name), join(dir, target.name)))
}

/**
 * Moves `from` to `to`, both inside `root`, across directories: the target's missing directories are made, and
 * neither side can be a link anywhere on its way (both directories are held open while the rename runs).
 * Replaces an entry already at `to` itself, never a link's target.
 */
export async function moveInside(root: string, from: string, to: string): Promise<void> {
  const source = partsOf(from)
  const target = partsOf(to)
  await inDir(root, source.dirs, false, (sourceDir) =>
    inDir(root, target.dirs, true, (targetDir) => rename(join(sourceDir, source.name), join(targetDir, target.name))))
}

/**
 * Removes the entry at `rel` inside `root`: a regular file (returns its size), or with `anyEntry` also a link or
 * other non-directory (a link itself, never its target). Undefined when there was nothing to remove.
 */
export async function removeInside(root: string, rel: string, { anyEntry = false } = {}): Promise<number | undefined> {
  const { dirs, name } = partsOf(rel)
  try {
    return await inDir(root, dirs, false, async (dir) => {
      const path = join(dir, name)
      const info = await lstat(path)
      if (info.isDirectory() || (!anyEntry && !info.isFile())) return undefined
      await rm(path)
      return info.isFile() ? info.size : 0
    })
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/** The text of a regular file at `rel` inside `root`; undefined when there is none (or it is a link). */
export async function readTextInside(root: string, rel: string): Promise<string | undefined> {
  const opened = await openInside(root, rel)
  if (!opened) return undefined
  try {
    return await opened.handle.readFile('utf8')
  } finally {
    await opened.handle.close()
  }
}

/** Replaces `rel` inside `root` whole: written to a fresh temporary file next to it, then renamed over it. */
export async function writeFileInside(root: string, rel: string, data: string | Buffer): Promise<void> {
  const temporary = `${rel}.${process.pid}.${Math.random().toString(36).slice(2)}`
  const file = await createInside(root, temporary)
  try {
    await file.writeFile(data)
  } finally {
    await file.close()
  }
  try {
    await renameInside(root, temporary, rel)
  } catch (error) {
    await removeInside(root, temporary, { anyEntry: true }).catch(() => undefined)
    throw error
  }
}

// ── Folder helpers (file_manage only) ────────────────────────────────────────────────────────────────────────────

/** `rel` as path parts; '' or '.' is the root itself. */
function dirPartsOf(rel: string): string[] {
  const parts = rel.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  if (parts.includes('..')) throw new NotInsideError(`not a path inside the directory: ${rel}`)
  return parts
}

export type EntryKind = 'file' | 'folder' | 'link' | 'other'
export interface Entry { name: string; kind: EntryKind; size: number; mtimeMs: number }

const kindOf = (info: Stats): EntryKind => (info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'folder' : info.isFile() ? 'file' : 'other')

/**
 * The names and kinds of the entries of the folder `rel` inside `root` (a link is reported as a link, never
 * followed); undefined when it is not a folder. Kinds come from the directory itself, so a folder of 100k entries
 * costs one read, not 100k lstat calls; size and time are not filled (0) — `statInside` the ones you show.
 */
export async function listInside(root: string, rel: string): Promise<Entry[] | undefined> {
  try {
    return await inDir(root, dirPartsOf(rel), false, async (dir) => {
      const entries: Entry[] = []
      for (const dirent of await readdir(dir, { withFileTypes: true })) {
        let kind: EntryKind = dirent.isSymbolicLink() ? 'link' : dirent.isDirectory() ? 'folder' : dirent.isFile() ? 'file' : 'other'
        if (kind === 'other' && !dirent.isFIFO() && !dirent.isSocket() && !dirent.isBlockDevice() && !dirent.isCharacterDevice()) {
          // a filesystem that does not report the type: ask
          const info = await lstat(join(dir, dirent.name)).catch(() => undefined)
          if (info) kind = kindOf(info)
        }
        entries.push({ name: dirent.name, kind, size: 0, mtimeMs: 0 })
      }
      return entries
    })
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/** What is at `rel` inside `root` (the entry itself, a link not followed); undefined when nothing is there. */
export async function statInside(root: string, rel: string): Promise<Entry | undefined> {
  const parts = dirPartsOf(rel)
  if (parts.length === 0) return { name: '.', kind: 'folder', size: 0, mtimeMs: 0 }
  const name = parts.pop()!
  try {
    return await inDir(root, parts, false, async (dir) => {
      const info = await lstat(join(dir, name))
      return { name, kind: kindOf(info), size: info.size, mtimeMs: info.mtimeMs }
    })
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/** Makes the folder `rel` inside `root` and any missing parents; no link can be on the way. */
export async function mkdirInside(root: string, rel: string): Promise<void> {
  const parts = dirPartsOf(rel)
  if (parts.length === 0) return
  await inDir(root, parts, true, async () => undefined)
}

/**
 * Copies the regular file `from` to `to`, both inside `root`: read through an open descriptor (never a link), written
 * to a fresh hidden file next to the target, then renamed over it — so `overwrite` replaces the target entry itself.
 * Returns the bytes copied.
 */
export async function copyFileInside(root: string, from: string, to: string, { overwrite = false } = {}): Promise<number> {
  const source = await openInside(root, from)
  if (!source) throw new NotInsideError(`not a file: ${from}`)
  const target = partsOf(to)
  const temporary = [...target.dirs, `.${target.name}.${process.pid}.${Math.random().toString(36).slice(2)}.part`].join('/')
  try {
    if (!overwrite && (await statInside(root, to)) !== undefined) throw Object.assign(new Error(`already exists: ${to}`), { code: 'EEXIST' })
    const file = await createInside(root, temporary)
    let copied = 0
    try {
      const counted = source.handle.createReadStream({ autoClose: false })
      counted.on('data', (chunk) => { copied += chunk.length })
      await pipeline(counted, file.createWriteStream())
      await renameInside(root, temporary, to)
    } catch (error) {
      await removeInside(root, temporary, { anyEntry: true }).catch(() => undefined)
      throw error
    }
    return copied
  } finally {
    await source.handle.close().catch(() => undefined)
  }
}

/** Removes the entry `rel` inside `root` and, for a folder, everything in it; a link inside is removed, never followed. */
export async function removeTreeInside(root: string, rel: string): Promise<void> {
  const { dirs, name } = partsOf(rel)
  try {
    await inDir(root, dirs, false, (dir) => rm(join(dir, name), { recursive: true, force: true }))
  } catch (error) {
    if (!missing(error)) throw error
  }
}
