// file_manage — list / mkdir / move / copy / delete / zip / unzip in a chat's working directory without a shell
// (docs/file-tools-plan.md §4.2). With read / write / edit /
// glob / grep it covers the file work the model otherwise did through bash (`ls -la`, `mv`, `cp`, `rm`, `mkdir`,
// `unzip`), and unlike bash it cannot leave the folder: every step goes through safe-fs, so no symlink on the way
// (one the model's own code made included) redirects it.
//
// What it never touches, whatever the model asks:
// - `.fox/` (the folder's manifests and the trash) and `.canvas/` (the panel's history);
// - the uploaded originals listed in `.fox/sources.json` (they may be copied, not moved, replaced or deleted);
// - canvas versions `canvas-<id>-v<N>.<ext>` (the panel's history: moved or deleted, a version disappears).
// In a project chat (the agent has an `outputDir`, e.g. generated/<sessionId>) it changes only that folder: the
// rest of the project belongs to the user and to the other chats.
// `delete` is a move into `.fox/trash/<time>/`, so a mistake can be undone (the result says how).
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { copyFileInside, listInside, mkdirInside, moveInside, NotInsideError, readTextInside, removeTreeInside, statInside, type Entry } from './safe-fs.ts'
import { MAX_BYTES, MAX_ENTRIES, runZip } from './zip.ts'

export const name = 'fox-harness-tool-file-manage'
export const inject = ['tools', 'systemPrompt']

const ACTIONS = ['list', 'mkdir', 'move', 'copy', 'delete', 'zip', 'unzip'] as const
type Action = (typeof ACTIONS)[number]

const MAX_LIST = 300
const MAX_COPY_FILES = 2000
const TRASH = '.fox/trash'
/** Trash older than this is removed for good (on the next file_manage call); the whole trash goes with the chat. */
const TRASH_DAYS = 7
/** Entries looked at when checking that a folder holds no canvas version before moving or deleting it. */
const MAX_SCAN = 5000
/** A project's shared output folder: a project chat may put results there too. */
const SHARED_OUTPUTS = 'outputs'
const CANVAS_VERSION = /^canvas-[a-z0-9][a-z0-9-]*-v\d+\.[^/]+$/

/** `path` as a clean relative path ('' = the folder itself); throws for `..` or an absolute path outside `cwd`. */
function relativePath(cwd: string, value: string | undefined): string {
  let text = (value ?? '').trim().replace(/\\/g, '/')
  const root = cwd.replace(/\/+$/, '')
  if (text.startsWith('/')) {
    if (text === root) text = ''
    else if (text.startsWith(`${root}/`)) text = text.slice(root.length + 1)
    else throw new Error(`"${value}" is outside the working directory`)
  }
  const parts = text.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.includes('..')) throw new Error(`"${value}" is outside the working directory (".." is not allowed)`)
  return parts.join('/')
}

const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const join = (...parts: string[]) => parts.filter(Boolean).join('/')

async function readSources(cwd: string): Promise<Set<string>> {
  try {
    const list = JSON.parse((await readTextInside(cwd, '.fox/sources.json')) ?? '[]') as unknown
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

interface Rules {
  cwd: string
  sources: Set<string>
  /** a project chat's own folder; undefined = the whole working directory is this chat's */
  own: string | undefined
}

/** Why `path` may not be changed (moved away, deleted: `change`) or written (a new or replaced entry: `target`). */
function refusal(rules: Rules, path: string, what: 'change' | 'target'): string | undefined {
  if (path === '') {
    // the folder itself is never moved or deleted; it is a fine place to unzip into, in a chat of its own
    return what === 'change' || rules.own !== undefined ? 'the working directory itself cannot be moved, deleted or replaced' : undefined
  }
  if (under(path, '.fox') || under(path, '.canvas')) return `"${path}" is internal (it holds the folder's records); it cannot be changed`
  for (const source of rules.sources) {
    // a change (move away, delete) of a folder takes the originals in it along; a target only collides with one
    if (what === 'change' ? under(source, path) : path === source) {
      return `"${source}" is a file the user uploaded: it is kept read-only as the original${rules.own !== undefined ? ', shared by every chat of the project' : ''}. Copy it (action "copy") and work on the copy`
    }
  }
  if (CANVAS_VERSION.test(baseName(path))) {
    return what === 'change'
      ? `"${path}" is a canvas version (the side panel's history); use canvas_write to make a new version`
      : `"${baseName(path)}" is the name of a canvas version (the side panel's history); pick another name`
  }
  if (rules.own !== undefined && !under(path, rules.own) && !(what === 'target' && under(path, SHARED_OUTPUTS))) {
    return `in this project chat only "${rules.own}/" (and "${SHARED_OUTPUTS}/" for shared results) can be changed; "${path}" belongs to the project. Put the result under "${rules.own}/"`
  }
  return undefined
}

/** Refuses a folder `change` (move away, delete) when a canvas version is anywhere in it: it would leave the panel's history. */
async function checkNoCanvasInside(rules: Rules, folder: string): Promise<void> {
  let seen = 0
  const scan = async (dir: string): Promise<void> => {
    for (const entry of (await listInside(rules.cwd, dir)) ?? []) {
      seen += 1
      if (seen > MAX_SCAN) throw new Error(`"${folder}" holds more than ${String(MAX_SCAN)} entries; move or delete smaller parts of it`)
      const rel = join(dir, entry.name)
      if (entry.kind === 'file' && CANVAS_VERSION.test(entry.name)) {
        throw new Error(`"${folder}" holds canvas versions (${rel}): the side panel's history cannot be moved or deleted; move or delete the other files one by one`)
      }
      if (entry.kind === 'folder') await scan(rel)
    }
  }
  await scan(folder)
}

/** Trash entries (`.fox/trash/<time>/…`) older than TRASH_DAYS, removed for good. */
async function purgeTrash(cwd: string, now: number): Promise<void> {
  for (const entry of (await listInside(cwd, TRASH)) ?? []) {
    // the name is an ISO time with ':' and '.' made '-': 2026-10-22T07-41-00-000Z
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(entry.name)
    const at = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN
    if (Number.isFinite(at) && now - at > TRASH_DAYS * 86_400_000) await removeTreeInside(cwd, join(TRASH, entry.name)).catch(() => undefined)
  }
}

function check(rules: Rules, path: string, what: 'change' | 'target'): void {
  const reason = refusal(rules, path, what)
  if (reason) throw new Error(reason)
}

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

async function list(rules: Rules, path: string, depth: number): Promise<string> {
  const top = await statInside(rules.cwd, path)
  if (top === undefined) throw new Error(`no folder at "${path || '.'}"`)
  if (top.kind === 'file') {
    return `${path}  ${size(top.size)}  ${stamp(top.mtimeMs)}${rules.sources.has(path) ? '  (uploaded original, read-only)' : ''}`
  }
  if (top.kind !== 'folder') throw new Error(`"${path}" is a link or special file; links are not followed`)
  const lines: string[] = []
  let shown = 0
  let more = 0
  const walk = async (folder: string, level: number): Promise<void> => {
    const entries = (await listInside(rules.cwd, folder)) ?? []
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => (a.kind === 'folder') === (b.kind === 'folder') ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1)
    for (const entry of visible) {
      if (shown >= MAX_LIST) { more += 1; continue } // counts this folder's rest; deeper levels are not visited
      shown += 1
      const rel = join(folder, entry.name)
      const indent = '  '.repeat(level)
      const shownEntry = entry.kind === 'file' ? ((await statInside(rules.cwd, rel)) ?? entry) : entry
      lines.push(describe(indent, shownEntry, rel, rules))
      if (entry.kind === 'folder' && level + 1 < depth) await walk(rel, level + 1)
    }
  }
  await walk(path, 0)
  const head = `${path || '.'}/`
  if (lines.length === 0) return `${head}\n(empty)`
  return [head, ...lines, ...(more > 0 ? [`… ${String(more)} more not shown (list a subfolder, or use glob)`] : [])].join('\n')
}

function describe(indent: string, entry: Entry, rel: string, rules: Rules): string {
  if (entry.kind === 'folder') return `${indent}${entry.name}/`
  if (entry.kind === 'link') return `${indent}${entry.name}  (link, not followed)`
  if (entry.kind === 'other') return `${indent}${entry.name}  (special file)`
  return `${indent}${entry.name}  ${size(entry.size)}  ${stamp(entry.mtimeMs)}${rules.sources.has(rel) ? '  (uploaded original, read-only)' : ''}`
}

/** `to` for move / copy: into an existing folder keeps the name. */
async function targetFor(rules: Rules, from: string, to: string): Promise<string> {
  const existing = to === '' ? { kind: 'folder' } : await statInside(rules.cwd, to)
  return existing?.kind === 'folder' ? join(to, baseName(from)) : to
}

async function copyTree(rules: Rules, from: string, to: string, overwrite: boolean): Promise<{ files: number; bytes: number; skipped: number }> {
  const totals = { files: 0, bytes: 0, skipped: 0 }
  const copy = async (source: string, target: string): Promise<void> => {
    const entry = await statInside(rules.cwd, source)
    if (entry?.kind === 'file' || entry?.kind === 'folder') check(rules, target, 'target') // every file written, not just the top
    if (entry?.kind === 'file') {
      if (totals.files >= MAX_COPY_FILES || totals.bytes + entry.size > MAX_BYTES) {
        throw new Error(`too much to copy at once: at most ${String(MAX_COPY_FILES)} files and ${size(MAX_BYTES)}`)
      }
      totals.bytes += await copyFileInside(rules.cwd, source, target, { overwrite })
      totals.files += 1
    } else if (entry?.kind === 'folder') {
      await mkdirInside(rules.cwd, target)
      for (const child of (await listInside(rules.cwd, source)) ?? []) {
        if (child.name === '.fox' || child.name === '.canvas') continue
        await copy(join(source, child.name), join(target, child.name))
      }
    } else {
      totals.skipped += 1 // a link or special file is never copied
    }
  }
  await copy(from, to)
  return totals
}

function trashName(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:file_manage',
    order: 100,
    text: [
      'Work on files with the dedicated tools, not shell commands: read / glob / grep to look (not cat, ls, find,',
      'grep), write (or edit, where you have it) to change a text file (not sed or echo > file), file_manage to list, make folders, move,',
      'copy, delete, zip and unzip (not ls, mkdir, mv, cp, rm, zip, unzip). Uploaded originals are read-only: copy',
      'one before changing it. bash, where you have it, is only for running a program no tool covers.',
    ].join(' '),
  })

  ctx.tools.register(
    defineTool({
      name: 'file_manage',
      description: [
        "Manage files in this chat's working directory without a shell — use it instead of ls / mkdir / mv / cp / rm / zip / unzip.",
        'Actions: "list" (path, depth 1–4: folders first, size and modified time; hidden files are not shown),',
        '"mkdir" (path), "move" (path → to; into an existing folder keeps the name), "copy" (path → to, a file or a folder),',
        `"delete" (path: moved to the trash, restorable for ${String(TRASH_DAYS)} days), "zip" (path → to, default <path>.zip),`,
        `"unzip" (path → to, default a folder named after the archive; at most ${String(MAX_ENTRIES)} entries / ${size(MAX_BYTES)}).`,
        'An existing target is not replaced unless overwrite is true. Uploaded originals, canvas versions and internal',
        'folders cannot be moved, replaced or deleted. Links are never followed. For file contents use read / write / edit.',
      ].join(' '),
      parameters: {
        action: { type: 'string', required: true, enum: ACTIONS, description: 'list | mkdir | move | copy | delete | zip | unzip' },
        path: { type: 'string', description: 'File or folder, relative to the working directory. "list" defaults to the folder itself.' },
        to: { type: 'string', description: 'Target for move / copy / zip / unzip.' },
        overwrite: { type: 'boolean', description: 'Replace an existing target. Defaults to false.' },
        depth: { type: 'integer', description: '"list" only: levels to show, 1–4. Defaults to 2.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const cwd = exec.agent?.session.header.cwd
        if (cwd === undefined) throw new Error('no working directory for this session')
        const action = args.action as Action
        const output = (exec.agent?.options as { outputDir?: string } | undefined)?.outputDir
        const rules: Rules = {
          cwd,
          sources: await readSources(cwd),
          own: output === undefined ? undefined : relativePath(cwd, output),
        }
        const path = relativePath(cwd, args.path)
        const overwrite = args.overwrite === true
        await purgeTrash(cwd, Date.now()).catch(() => undefined)
        try {
          return await run(action, rules, path, args, overwrite, exec.signal)
        } catch (error) {
          // safe-fs refuses a link (ELOOP) or a file where a folder was expected (ENOTDIR) anywhere on the way
          const code = (error as { code?: string }).code
          const where = `"${path}"${args.to === undefined ? '' : ` or "${args.to}"`}`
          if (error instanceof NotInsideError || code === 'ELOOP') throw new Error(`a link is in the way on ${where}; links are not followed`)
          // Linux reports a link opened as a folder (O_DIRECTORY | O_NOFOLLOW) as ENOTDIR, not ELOOP
          if (code === 'ENOTDIR') throw new Error(`a link or a file is where a folder is expected on ${where}; links are not followed`)
          if (code === 'EISDIR') throw new Error(`a folder is in the way on ${where}`)
          if (code === 'EEXIST') throw new Error(`${(error as Error).message.replace(/^EEXIST: /, '')} (pass overwrite: true to replace it)`)
          if (code === 'ENOTEMPTY') throw new Error(`the target folder is not empty; pick another name`)
          // never show the runtime's own descriptor paths
          if (error instanceof Error) error.message = error.message.replace(/\/proc\/self\/fd\/\d+\/?/g, '')
          throw error
        }
      },
    }),
  )
}

type Args = { path?: string; to?: string; depth?: number }

async function run(action: Action, rules: Rules, path: string, args: Args, overwrite: boolean, signal: AbortSignal | undefined): Promise<string> {
  const { cwd } = rules
  switch (action) {
    case 'list': {
      const depth = Math.min(4, Math.max(1, Math.floor(Number(args.depth ?? 2)) || 2))
      return list(rules, path, depth)
    }
    case 'mkdir': {
      if (path === '') throw new Error('mkdir needs `path`')
      check(rules, path, 'target')
      await mkdirInside(cwd, path)
      return `Folder ready: ${path}/`
    }
    case 'move':
    case 'copy': {
      if (path === '' || args.to === undefined) throw new Error(`${action} needs \`path\` and \`to\``)
      const entry = await statInside(cwd, path)
      if (entry === undefined) throw new Error(`nothing at "${path}"`)
      if (entry.kind === 'link' || entry.kind === 'other') throw new Error(`"${path}" is a link or special file; links are not followed`)
      const target = await targetFor(rules, path, relativePath(cwd, args.to))
      if (target === path) throw new Error('the source and the target are the same')
      if (entry.kind === 'folder' && under(target, path)) throw new Error(`cannot ${action} a folder into itself`)
      check(rules, target, 'target')
      if (action === 'copy') {
        const done = await copyTree(rules, path, target, overwrite)
        return `Copied ${path} → ${target} (${String(done.files)} file${done.files === 1 ? '' : 's'}, ${size(done.bytes)}${done.skipped > 0 ? `; ${String(done.skipped)} link(s) or special file(s) left out` : ''}).`
      }
      if (under(path, TRASH)) {
        // restoring from the trash is the one move out of .fox/; in a project only what came from this chat's folder
        const original = path.split('/').slice(3).join('/')
        if (rules.own !== undefined && !under(original, rules.own)) throw new Error(`"${path}" was not deleted from this chat's folder; it cannot be restored here`)
      } else {
        check(rules, path, 'change')
        if (entry.kind === 'folder') await checkNoCanvasInside(rules, path)
      }
      if (!overwrite && (await statInside(cwd, target)) !== undefined) throw new Error(`"${target}" already exists (pass overwrite: true to replace it)`)
      await moveInside(cwd, path, target)
      return `Moved ${path} → ${target}.`
    }
    case 'delete': {
      if (path === '') throw new Error('delete needs `path`')
      if (under(path, TRASH)) throw new Error(`items in the trash are removed for good after ${String(TRASH_DAYS)} days; they cannot be deleted one by one`)
      check(rules, path, 'change')
      const existing = await statInside(cwd, path)
      if (existing === undefined) throw new Error(`nothing at "${path}"`)
      if (existing.kind === 'folder') await checkNoCanvasInside(rules, path)
      const trashed = join(TRASH, trashName(Date.now()), path)
      await moveInside(cwd, path, trashed)
      return `Moved ${path} to the trash (${trashed}), kept ${String(TRASH_DAYS)} days. To restore it: file_manage action "move", path "${trashed}", to "${path}".`
    }
    case 'zip':
    case 'unzip': {
      if (path === '' && action === 'unzip') throw new Error('unzip needs `path` (the .zip file)')
      const source = await statInside(cwd, path)
      if (source === undefined) throw new Error(`nothing at "${path}"`)
      if (source.kind === 'link' || source.kind === 'other') throw new Error(`"${path}" is a link or special file; links are not followed`)
      if (action === 'unzip' && source.kind !== 'file') throw new Error(`"${path}" is not a .zip file`)
      if (under(path, '.fox') || under(path, '.canvas')) throw new Error(`"${path}" is internal; it cannot be zipped`)
      const fallback = action === 'zip'
        ? `${path || 'files'}.zip`
        : path.replace(/\.zip$/i, '') === path ? `${path}-unzipped` : path.replace(/\.zip$/i, '')
      const requested = args.to === undefined ? fallback : relativePath(cwd, args.to)
      const target = rules.own !== undefined && args.to === undefined && !under(requested, rules.own)
        ? join(rules.own, baseName(requested))
        : requested
      check(rules, target, 'target')
      const done = await runZip(action, cwd, path || '.', target, overwrite, { sources: [...rules.sources] }, signal)
      return action === 'zip'
        ? `Zipped ${path || '.'} → ${target} (${String(done.files)} file${done.files === 1 ? '' : 's'}, ${size(done.bytes)}${done.skipped > 0 ? `; ${String(done.skipped)} link(s) or special file(s) left out` : ''}).`
        : `Unzipped ${path} → ${target}/ (${String(done.files)} file${done.files === 1 ? '' : 's'}, ${size(done.bytes)}${done.skipped > 0 ? `; ${String(done.skipped)} entr${done.skipped === 1 ? 'y' : 'ies'} skipped: links, __MACOSX, .DS_Store` : ''}).`
    }
  }
  throw new Error(`unknown action "${String(action)}"; use one of ${ACTIONS.join(', ')}`)
}
