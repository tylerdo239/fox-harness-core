import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolGuard } from '@deepseek-ai/dsh-tools'

// One dsh process serves many users' sessions, so "which files may this agent's
// tools touch" can no longer be answered by "whatever the container sees".
// `dsh-fs-sandbox`'s fence only checks MUTATIONS and always lets reads through,
// and the in-process `read`/`glob`/`grep`/`str_replace_editor` tools run in the
// runtime process itself, outside any bwrap (measured: scripts/spike-single-
// runtime.mjs `crossUserRead`, docs/single-backend-architecture-plan.md).
//
// This guard denies any tool call whose path-like argument resolves — after
// following symlinks — outside the calling session's own cwd. It is a POLICY
// fence in the same sense dsh calls its own one: it has a check-then-use window
// (a symlink flipped between this check and the tool body) and it cannot see
// inside a `bash` command line; kernel-level confinement of bash/python is the
// sandbox's job (bwrap), not this file's.

const PATH_KEYS = new Set(['file_path', 'path', 'paths', 'directory', 'dir', 'cwd', 'notebook_path', 'target', 'source', 'destination', 'old_path', 'new_path'])
// Tools that only read; they may additionally read the shared (read-only) skill/data dirs.
const READ_ONLY_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'skill'])

// docs/file-tools-plan.md §4.3: what no file tool may change, even inside the session's own folder.
// - `.fox/` (manifests, trash) and `.canvas/` (the panel's history);
// - the uploaded originals (`.fox/sources.json`): they are chmod 0444, but `write` publishes with a temp file and a
//   rename (dsh-fs-local), which only needs the FOLDER to be writable — so without this a 0444 upload is replaced;
// - canvas versions `canvas-<id>-v<N>.<ext>`: an in-place edit never reaches the panel (QA 2026-10-16); canvas_write
//   makes the next version.
const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const CANVAS_VERSION = /(^|\/)canvas-[a-z0-9][a-z0-9-]*-v\d+\.[^/]+$/

/** The uploaded originals of the folder at `root`, read without following a link or blocking on a FIFO. */
function readSources(root: string): Set<string> {
  let fd: number | undefined
  try {
    fd = openSync(`${root}/.fox/sources.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) return new Set()
    const list = JSON.parse(readFileSync(fd, 'utf8')) as unknown
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function protectedReason(rel: string, sources: () => Set<string>): string | undefined {
  const path = rel.split(sep).join('/')
  if (path === '.fox' || path.startsWith('.fox/') || path === '.canvas' || path.startsWith('.canvas/')) {
    return `"${path}" is internal to the folder; it cannot be written`
  }
  if (CANVAS_VERSION.test(path)) return `"${path}" is a canvas version; to change the canvas, call canvas_write with the same id`
  if (sources().has(path)) {
    return `"${path}" is a file the user uploaded: it is kept read-only as the original. Write the changed data to a new file instead`
  }
  return undefined
}

// docs/file-tools-plan.md §4.1: bash stays (user and admin) for running programs no tool covers, but a command that
// only does file work is sent to the dedicated tools. A steering rule, not a security fence: a script can always
// wrap these commands. A command that also runs anything else passes (`npm test | tail`).
const FILE_COMMANDS = new Set([
  'ls', 'dir', 'tree', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'du', 'find', 'grep', 'egrep',
  'fgrep', 'rg', 'sed', 'awk', 'cut', 'sort', 'uniq', 'touch', 'mkdir', 'rmdir', 'mv', 'cp', 'rm', 'ln', 'zip',
  'unzip', 'tee', 'xargs',
])
// tar is not one: file_manage has no tar.gz. xargs and find -exec run whatever program follows them (checked below).
/** Do nothing on their own: neither a file operation nor a program. */
const NEUTRAL_COMMANDS = new Set(['cd', 'pwd', 'echo', 'printf', 'true', 'false', 'exit', 'set', 'export', ':'])

/** `command` with each here-document's body removed (`cat <<EOF > f` … `EOF`): its lines are data, not commands. */
function withoutHereDocBodies(command: string): string {
  const lines = command.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]!)
    // `<<EOF` / `<<-'EOF'`, not a `<<<` here-string
    const marker = /(?<!<)<<-?(?!<)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i]!)
    if (!marker) continue
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== marker[2]) i += 1
    i += 1 // the closing delimiter
  }
  return out.join('\n')
}

/** The program a file command runs for each file (`xargs python3 x.py`, `find … -exec python3 x.py {} ;`), if any. */
function runsProgram(first: string, words: string[]): boolean {
  const program = (word: string | undefined) => word !== undefined && !FILE_COMMANDS.has(word.split('/').pop()!) && !NEUTRAL_COMMANDS.has(word.split('/').pop()!)
  if (first === 'xargs') return program(words.slice(1).find((word) => !word.startsWith('-')))
  if (first === 'find') {
    const at = words.findIndex((word) => word === '-exec' || word === '-execdir' || word === '-ok' || word === '-okdir')
    return at >= 0 && program(words[at + 1])
  }
  return false
}

/**
 * True when every part of `command` is a plain file command (and at least one is) on the session's own files. A
 * file command on an absolute path outside `cwd` (`cat /etc/os-release`) is not refused: the file tools are
 * fenced to the workspace, so there is no tool to send it to — what bash may read there is the sandbox's call.
 */
export function onlyFileWork(command: string, cwd?: string): boolean {
  // command substitution, subshells and here-strings run what they contain: not judged here
  if (/\$\(|`|<\(|>\(/.test(command)) return false
  let sawFileCommand = false
  for (const segment of withoutHereDocBodies(command).split(/&&|\|\||[;|&\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean)
    // leading VAR=value assignments, then the command's own name (a path like /bin/ls counts as ls)
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift()
    let first = words[0]?.replace(/^\(+/, '').split('/').pop()
    if (first === undefined || first === '' || first.startsWith('<<') || /^[<>0-9]/.test(first)) continue // a here-doc body line or a bare redirect
    if (first === 'sudo' || first === 'command' || first === 'time') first = words[1]?.split('/').pop()
    if (first === undefined) continue
    if (FILE_COMMANDS.has(first)) {
      if (runsProgram(first, words)) return false
      if (cwd !== undefined && words.slice(1).some((word) => word.startsWith('/') && !isInside(cwd, word))) return false
      sawFileCommand = true
    } else if (!NEUTRAL_COMMANDS.has(first)) return false
    // `echo … > file` writes a file (a `2>` / `>&` redirect does not count)
    else if ((first === 'echo' || first === 'printf') && /(^|[^0-9&>])>>?\s*[^&\s]/.test(segment)) sawFileCommand = true
  }
  return sawFileCommand
}

export const BASH_FILE_WORK =
  'bash is only for running programs no tool covers. Use read / glob / grep to look at files, edit / write to change '
  + 'a text file, and file_manage to list, make folders, move, copy, delete, zip or unzip.'

function realpathOrAncestor(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(current.slice(parent.length + 1))
      current = parent
    }
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(root, path.replace(/^['"]|['"]$/g, '')))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Every path-like string in a tool's arguments, at any depth (a tool may take `edits: [{ file_path }]`). */
function collectPaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PATH_KEYS.has(key)) {
      for (const entry of Array.isArray(item) ? item : [item]) if (typeof entry === 'string') out.push(entry)
    } else if (key === 'pattern' && typeof item === 'string') {
      // A glob pattern can carry its own base ("/other/**", "../x/*").
      if (isAbsolute(item) || item.split(/[\\/]/).includes('..')) {
        out.push(isAbsolute(item) ? item.split(/[\\/]/).filter((part) => !/[*?[\]{}]/.test(part)).join(sep) || sep : item)
      }
    }
    if (typeof item === 'object') collectPaths(item, out, depth + 1)
  }
}

/**
 * Registered GLOBALLY (packages/agent-core/src/transport/index.ts), not per agent: a subagent gets its own scope
 * (joined to the parent's preset, not to the parent's agent scope), so a guard on the parent's scope
 * did not cover it — measured: a subagent's `read` returned another user's file. Every agent's calls
 * pass here and are judged against THAT agent's session cwd (a subagent shares its parent's cwd).
 */
export function workspaceGuard(sharedReadDirs: readonly string[] = []): ToolGuard {
  const shared = sharedReadDirs.map((dir) => realpathOrAncestor(resolve(dir)))
  return (execution) => {
    if (execution.name === 'bash') {
      const command = (execution.arguments as { command?: unknown } | undefined)?.command
      if (typeof command === 'string' && onlyFileWork(command, execution.agent?.session.header.cwd)) return BASH_FILE_WORK
    }
    const paths: string[] = []
    collectPaths(execution.arguments, paths)
    if (paths.length === 0) return undefined
    const cwd = execution.agent?.session.header.cwd
    if (!cwd) return 'workspace guard: this call names a path but its session has no working directory'
    const root = realpathOrAncestor(resolve(cwd))
    const readOnly = READ_ONLY_TOOLS.has(execution.name)
    // str_replace_editor's `view` only reads
    const mutating = MUTATING_TOOLS.has(execution.name)
      && !(execution.name === 'str_replace_editor' && (execution.arguments as { command?: unknown } | undefined)?.command === 'view')
    let sources: Set<string> | undefined
    for (const value of paths) {
      const target = realpathOrAncestor(resolve(root, value))
      if (inside(root, target)) {
        if (mutating) {
          const reason = protectedReason(relative(root, target), () => (sources ??= readSources(root)))
          if (reason !== undefined) return `workspace guard: ${reason}`
        }
        continue
      }
      if (readOnly && shared.some((dir) => inside(dir, target))) continue
      return `workspace guard: "${value}" is outside this session's workspace`
    }
    return undefined
  }
}
