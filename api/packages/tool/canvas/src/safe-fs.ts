// A copy of services/gateway/src/runtime/safe-fs.ts — packages never import a service's code (docs/code-rules.md §1),
// so keep the two in step.
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
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
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
