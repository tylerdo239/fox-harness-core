// Ported from local-fox-harness-core (packages/tool/canvas) — app/src/components/features/canvas is the UI half.
// Changes for this repo: a project chat writes into its own output folder (the python tool's `outputDir`), the
// marker is `<!--fox-canvas:…-->`, and the guidance names only the libraries this backend's python has.
//
// The Canvas tool — the model's side of apps/web's "Canvas" panel (a
// Claude-Artifacts/Gemini-Canvas-style side surface for long code/markdown
// the user will keep copying, editing, or reusing, instead of it scrolling
// past inline in the chat stream).
//
// Design constraint this works around: dsh-llm's ContentBlock union (text/
// reasoning/image/file/tool_call/tool_result — confirmed by reading its
// compiled .d.ts, `@deepseek-ai/dsh-llm/lib/types/content.d.ts`) is closed —
// a tool cannot invent a new block type ("canvas") without touching a
// vendored package, which packages/ never does (it has to stay mergeable
// with `git merge upstream/master`, see docs/cordis-agent-architecture.md
// §3.2). The upstream `presentCall`/`presentResult` presentation system
// (dsh-tools' presentation.d.ts) looks tailor-made for this but is a dead
// end too: it exists for dsh-web-app's OWN React client, which
// packages/bundle-core/cordis.patch.yml disables wholesale in favor of
// apps/web — and apps/web's conversation.tsx never reads presentResult, only
// raw `type: 'text'` blocks (confirmed by reading it end to end).
//
// So this tool stays inside the one convention every tool in this repo
// already uses (create-skill, n8n, gmail-browser all emit `type: 'text'`
// only) and signals the UI the same way JSON-in-text tools like n8n's
// renderJson do: the confirmation text carries an HTML-comment marker
// (`<!--fox-canvas:{...}-->`) apps/web's conversation.tsx greps for. The
// marker itself carries only METADATA (id/kind/title/language/path/version),
// never the content — the actual bytes live in a real file inside the
// session's workspace directory, written under a versioned name
// (`canvas-<id>-v<N>.<ext>`) so:
//   - every past version stays readable as its own immutable file (a plain
//     `readdir` recovers full history — no separate version-tracking state
//     needed anywhere, and no backend route needed either: the existing
//     `/workspace-file` GET already serves it, path-traversal-guarded).
//   - the confirmation text stays short regardless of content size — a
//     canvas write doesn't bloat the model's own context on every later
//     replay the way embedding the full content in the tool result would
//     (the same reason `read`/`write`-style tools return "wrote N bytes",
//     not the bytes themselves).
//   - the panel's "Save" button (user edits) can write the very next version
//     through `/workspace-upload` verbatim — no new backend code at all.
//
// kind:"file" — the Office/PDF path. Real failure it exists for: asked to
// "format về excel", the agent built a correct .xlsx with openpyxl through
// `bash`, but the panel kept showing the earlier markdown canvas — the only
// way into the panel was a UTF-8 `content` string, which cannot carry a
// binary file (and a model cannot emit .xlsx bytes anyway). So instead of
// content, a file canvas takes the `path` of a file the agent already wrote
// into the workspace and snapshots it as the next `canvas-<id>-v<N>.<ext>`
// (a byte copy, so later edits to the original don't rewrite history). The
// panel then picks a renderer by extension. Same marker, same versioning.
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createInside, openInside, readTextInside } from './safe-fs.ts'

export const name = 'fox-harness-tool-canvas'
export const inject = ['tools']

// Mirrors create-skill's NAME_RE convention: kebab-case, predictable as a
// filename fragment. Optional in the tool call but never optional once
// resolved, since it becomes part of a real path on disk.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const DEFAULT_ID = 'main'

/**
 * The id a call without one gets: its title as a slug. A fixed "main" made every id-less call the next
 * version of one canvas (QA 2026-10-15: a markdown report replaced the Excel canvas of the turn before).
 */
function idFromTitle(title: string): string {
  const slug = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 48).replace(/-+$/, '')
  return slug === '' ? DEFAULT_ID : slug
}
const MAX_TITLE_CHARS = 200
// Generous on purpose: unlike create_skill's 64 KB cap (a skill is read into
// every future prompt), a canvas's content never re-enters the model's
// context on its own — only the short marker does. 4 MB comfortably covers
// any code file or long document a person would actually want in a panel.
const MAX_CONTENT_BYTES = 4 * 1024 * 1024
// Office/PDF files the panel can render (apps/web canvas-panel.tsx's
// FilePreview). Anything else stays a plain workspace download — better a
// clear "unsupported type" error the model can react to than a canvas that
// opens onto an empty preview.
const FILE_EXTENSIONS = new Set(['.xlsx', '.csv', '.docx', '.pdf'])
/** Text files kind:"file" accepts by rendering them as a live code/markdown canvas instead. */
const TEXT_CANVAS_EXT: Record<string, { kind: 'code' | 'markdown'; language?: string }> = {
  '.html': { kind: 'code', language: 'html' },
  '.htm': { kind: 'code', language: 'html' },
  '.md': { kind: 'markdown' },
  '.markdown': { kind: 'markdown' },
  '.txt': { kind: 'code', language: 'text' },
  '.json': { kind: 'code', language: 'json' },
  '.yaml': { kind: 'code', language: 'yaml' },
  '.yml': { kind: 'code', language: 'yaml' },
  '.py': { kind: 'code', language: 'python' },
  '.js': { kind: 'code', language: 'javascript' },
  '.ts': { kind: 'code', language: 'typescript' },
  '.sql': { kind: 'code', language: 'sql' },
  '.sh': { kind: 'code', language: 'bash' },
  '.css': { kind: 'code', language: 'css' },
  '.xml': { kind: 'code', language: 'xml' },
  '.toml': { kind: 'code', language: 'toml' },
}
const MAX_FILE_BYTES = 20 * 1024 * 1024

type CanvasKind = 'code' | 'markdown' | 'file'

/** Resolves a model-supplied workspace path, refusing anything that leaves `cwd` (absolute paths inside it are fine — the model often echoes back the full path a tool printed). */
function insideCwd(cwd: string, path: string): string | undefined {
  const absolute = resolve(cwd, path)
  const rel = relative(cwd, absolute)
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) return undefined
  return absolute
}

// Extension picked from the declared language (best-effort — unknown or
// omitted languages fall back to plain text) so downloads and the panel's
// syntax highlighter both get a real file type. Markdown ignores this
// entirely; it is always `.md`.
const LANGUAGE_EXT: Record<string, string> = {
  typescript: '.ts', ts: '.ts', tsx: '.tsx',
  javascript: '.js', js: '.js', jsx: '.jsx',
  python: '.py', py: '.py',
  bash: '.sh', sh: '.sh', shell: '.sh',
  json: '.json', yaml: '.yaml', yml: '.yaml',
  html: '.html', css: '.css', scss: '.scss',
  sql: '.sql', go: '.go', rust: '.rs', rs: '.rs',
  java: '.java', c: '.c', cpp: '.cpp', 'c++': '.cpp',
  php: '.php', ruby: '.rb', rb: '.rb', kotlin: '.kt', swift: '.swift',
  toml: '.toml', xml: '.xml', dockerfile: '.dockerfile',
}

function extensionFor(kind: 'code' | 'markdown', language: string | undefined): string {
  if (kind === 'markdown') return '.md'
  const key = language?.trim().toLowerCase()
  return (key !== undefined && LANGUAGE_EXT[key] !== undefined) ? LANGUAGE_EXT[key] : '.txt'
}

/** Highest existing `canvas-<id>-v<N>.*` version under `cwd`, plus one. A plain directory scan — no state kept anywhere else, so history survives a container restart same as any other workspace file. */
async function nextVersion(cwd: string, id: string): Promise<number> {
  const prefix = `canvas-${id}-v`
  const entries = await readdir(cwd).catch(() => [] as string[])
  let max = 0
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const match = /^(\d+)\./.exec(entry.slice(prefix.length))
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

/**
 * docs/workspace-symlink-isolation-plan.md (C1). This tool runs in the runtime, outside the sandbox, and the
 * model's python can put a symlink in the folder (`env.txt -> /proc/self/environ`, a link to another user's
 * folder). Layer 1: the file is opened through safe-fs (no link anywhere on the way; type and size come from what
 * was opened). Layer 2: its bytes are then read by `cat` under the same sandbox runner as the python tool, with
 * the folder mounted read-only — it sees exactly what python sees, so a link out of the folder is a broken link
 * there whatever happens in between. Without a runner (a developer's machine) layer 1 reads them.
 */
async function readSource(cwd: string, absolute: string, maxBytes: number): Promise<{ bytes: Buffer } | { error: string }> {
  const rel = relative(cwd, absolute)
  const opened = await openInside(cwd, rel)
  if (opened === undefined) return { error: 'missing' }
  try {
    if (opened.info.size === 0 || opened.info.size > maxBytes) return { error: 'size' }
    const runner = globalThis.process.env.FOX_CONFINE_RUNNER
    if (!runner) return { bytes: await opened.handle.readFile() }
  } finally {
    await opened.handle.close()
  }
  return { bytes: await sandboxedCat(globalThis.process.env.FOX_CONFINE_RUNNER!, cwd, rel, maxBytes) }
}

const CAT_TIMEOUT_MS = 30_000

function sandboxedCat(runner: string, cwd: string, rel: string, maxBytes: number): Promise<Buffer> {
  // No --tmpfs: docker/fox-confine.sh then mounts the folder read-only (and chdirs into it).
  const args = ['--ro-bind', '/', '/', '--bind', cwd, cwd, '--', '/usr/bin/cat', '--', rel]
  return new Promise((resolvePromise, reject) => {
    const child = spawn(runner, args, { cwd, env: { PATH: globalThis.process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    let failure: Error | undefined
    const timer = setTimeout(() => {
      failure = new Error('reading the file took too long')
      child.kill('SIGKILL')
    }, CAT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        failure ??= new Error(`file is larger than ${String(maxBytes)} bytes`)
        child.kill('SIGKILL')
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-500) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error(`could not read "${rel}": ${stderr.trim() || `exit ${String(code)}`}`))
      resolvePromise(Buffer.concat(chunks))
    })
  })
}

/**
 * Writes the next version `canvas-<id>-v<N><ext>` under `outRel` (relative to cwd) through safe-fs (C2): a new file
 * only (O_EXCL), never through a link python put under that name or on the way. A name already taken — by such a
 * link, or a concurrent call — moves on to the next version.
 */
async function writeVersion(cwd: string, outRel: string, id: string, ext: string, data: Buffer | string): Promise<{ path: string; version: number }> {
  let version = Math.max(await nextVersion(join(cwd, outRel), id), await savedEditsVersion(cwd, id) + 1)
  for (let attempt = 0; attempt < 5; attempt += 1, version += 1) {
    const path = `${outRel}canvas-${id}-v${String(version)}${ext}`
    let file
    try {
      file = await createInside(cwd, path)
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') continue
      throw error
    }
    try {
      await file.writeFile(data)
    } finally {
      await file.close()
    }
    return { path, version }
  }
  throw new Error(`could not pick a free version name for canvas "${id}"`)
}

/**
 * The highest version the user saved for canvas `id` in the panel (`.canvas/index.json`, written by the gateway —
 * docs/canvas-storage-plan.md). The model's next version goes above it, so the two never share a number.
 */
async function savedEditsVersion(cwd: string, id: string): Promise<number> {
  try {
    const raw = await readTextInside(cwd, '.canvas/index.json')
    const entries = raw === undefined ? undefined : (JSON.parse(raw) as { canvases?: Record<string, { version?: unknown }[]> }).canvases?.[id]
    return Math.max(0, ...(Array.isArray(entries) ? entries : []).map((e) => (Number.isInteger(e.version) ? Number(e.version) : 0)))
  } catch {
    return 0
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_write',
      // Kept short on purpose: this text rides on every model request. Measured 2026-10-16 (24k window): the
      // former 4,200-character version was the largest tool description, ~1.2k tokens of a ~7k fixed prompt.
      description: [
        'Show a long document, code file or Office/PDF file in the side "Canvas" panel next to the chat.',
        'Short content (under ~20 lines) stays in the reply.',
        'LONG text (a report or guide over ~150 lines / 600 words): do not pass it as `content` — one huge',
        'call can overflow the context. Build it in python in parts (`report = "..."`, then `report += "..."`',
        'in later calls, a few sections each), save it with save_artifact("<name>.md", report), and call this',
        'tool with kind:"markdown" and `path` set to the returned path.',
        'A web page / dashboard: kind:"code", language:"html", one self-contained HTML file (CSS/JS inline,',
        'libraries from a CDN); the panel renders it live.',
        'Excel/Word/PDF: write the file with python (openpyxl/pandas .xlsx/.csv, python-docx .docx, a',
        'matplotlib figure .pdf), then call kind:"file" with its `path`; one id per format.',
        'The same id makes a new version of that canvas, a new id a separate one. To change a canvas, read its',
        'current file (the path your last call returned) and change only what was asked.',
      ].join(' '),
      parameters: {
        id: {
          type: 'string',
          description: 'kebab-case id, e.g. "weekly-report"; reuse it for a new version. Defaults to the title as a slug.',
        },
        kind: {
          type: 'string',
          required: true,
          enum: ['code', 'markdown', 'file'] as const,
          description: '"code" (with `language`), "markdown", or "file" (.xlsx/.csv/.docx/.pdf already written; pass `path`).',
        },
        title: {
          type: 'string',
          required: true,
          description: `Panel header, at most ${String(MAX_TITLE_CHARS)} characters.`,
        },
        language: {
          type: 'string',
          description: 'kind:"code" only, e.g. "html" (live preview), "python", "json".',
        },
        content: {
          type: 'string',
          description: 'Short code/markdown content. For long text pass `path` instead (see above).',
        },
        path: {
          type: 'string',
          description: 'A file in the working directory to show: required for kind:"file"; for code/markdown it replaces `content`.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            kind: { type: 'string', required: true },
            title: { type: 'string', required: true },
            language: { type: 'string' },
            path: { type: 'string', required: true },
            version: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => {
          const marker = JSON.stringify({
            id: value.id,
            kind: value.kind,
            title: value.title,
            ...(value.language === undefined ? {} : { language: value.language }),
            path: value.path,
            version: value.version,
          })
          return [{
            type: 'text',
            // The reminder travels with every result, not just the system
            // prompt's Canvas section — this is what the model actually sees
            // again right before deciding how to make the NEXT edit, which is
            // exactly where "read first, patch, don't rewrite" needs to land.
            text: value.kind === 'file'
              // A binary snapshot can't be "read and patched" as text: the
              // equivalent instruction is to open it with the same python
              // library, change only the requested cells/paragraphs, save, and
              // re-attach — which is what keeps a user's layout intact.
              ? `Canvas "${value.title}" saved (v${String(value.version)}) → ${value.path}. Opened in the side panel as a live preview. To change it, open ${value.path} with the same python library (openpyxl), edit only what was asked, save it under a new name, then call canvas_write kind:"file" with the SAME id and that path — don't rebuild it from scratch.\n<!--fox-canvas:${marker}-->`
              : `Canvas "${value.title}" saved (v${String(value.version)}) → ${value.path}. Opened in the side panel. To edit this canvas again, read ${value.path} first and patch it — don't rewrite it from memory.\n<!--fox-canvas:${marker}-->`,
          }]
        },
      },
      async execute(args, exec) {
        const kind: CanvasKind = args.kind
        const title = args.title.trim()
        if (title === '' || title.length > MAX_TITLE_CHARS) {
          throw new Error(`title is required and at most ${String(MAX_TITLE_CHARS)} characters`)
        }
        const id = args.id?.trim() || idFromTitle(title)
        if (!ID_RE.test(id)) throw new Error(`invalid id "${id}": use kebab-case, e.g. "main" or "weekly-report"`)
        const cwd = exec.agent?.session.header.cwd
        if (cwd === undefined) throw new Error('no working directory for this session')
        // A project chat (cwd carries the ownership ledger) writes its canvases
        // into this chat's own generated/<sessionId>/ folder, the same place
        // python artifacts go — so the Files panel files them under "Chat này"
        // instead of showing a root-level file with no owner until the next
        // turn's reconcile moves it.
        // `outputDir` rides on the agent's options (packages/agent-core's transport sets it per session).
        const output = (exec.agent?.options as { outputDir?: string } | undefined)?.outputDir
        // Without one (a chat of its own), straight into generated/<this chat>/: the end-of-turn reconcile
        // (flow/data-analysis/src/reconcile.ts) would move a root-level canvas there anyway, and the path in the
        // marker the panel keeps would then point at nothing (docs/canvas-storage-plan.md).
        const sessionId = exec.agent?.session.id
        const relativeBase = output !== undefined
          ? `${output.replace(/\/+$/, '')}/`
          : sessionId !== undefined && /^[0-9a-f-]{36}$/i.test(sessionId) ? `generated/${sessionId}/` : ''

        if (kind === 'file') {
          const requested = args.path?.trim() ?? ''
          if (requested === '') throw new Error('kind:"file" needs `path`: the .xlsx/.csv/.docx/.pdf you wrote into the working directory')
          const source = insideCwd(cwd, requested)
          if (source === undefined) throw new Error(`path "${requested}" is outside the working directory`)
          const ext = extname(source).toLowerCase()
          const missing = `no file at "${requested}" — write it first (e.g. with python), then call canvas_write`

          // Forgiving fallback, measured live: asked for an HTML chart, the
          // model called kind:"file" with the .html path and burned three more
          // steps (unsupported type → code without content → malformed retry).
          // A text file the panel can render as a live code/markdown canvas is
          // accepted here directly; only truly unrenderable types still error.
          const textKind = TEXT_CANVAS_EXT[ext]
          if (!FILE_EXTENSIONS.has(ext)) {
            if (textKind === undefined) {
              throw new Error(`unsupported file type "${ext || '(none)'}" — kind:"file" takes ${[...FILE_EXTENSIONS].join(', ')}; text files (${Object.keys(TEXT_CANVAS_EXT).join(', ')}) open as code/markdown canvases`)
            }
            const read = await readSource(cwd, source, MAX_CONTENT_BYTES)
            if ('error' in read) {
              throw new Error(read.error === 'missing' ? missing : `file must be non-empty and at most ${String(MAX_CONTENT_BYTES / (1024 * 1024))} MB for a text canvas`)
            }
            const { path, version } = await writeVersion(cwd, relativeBase, id, ext, read.bytes)
            return {
              id,
              kind: textKind.kind,
              title,
              ...(textKind.language === undefined ? {} : { language: textKind.language }),
              path,
              version,
            }
          }
          const read = await readSource(cwd, source, MAX_FILE_BYTES)
          if ('error' in read) {
            throw new Error(read.error === 'missing' ? missing : `file must be non-empty and at most ${String(MAX_FILE_BYTES / (1024 * 1024))} MB`)
          }
          const { path, version } = await writeVersion(cwd, relativeBase, id, ext, read.bytes)
          return { id, kind, title, path, version }
        }

        // kind:code / kind:markdown — a missing `content` with a `path` to a
        // text file is read instead of failing (same measured detour as above).
        let content = args.content ?? ''
        if (content === '' && args.path !== undefined) {
          const source = insideCwd(cwd, args.path.trim())
          const read = source === undefined ? undefined : await readSource(cwd, source, MAX_CONTENT_BYTES).catch(() => undefined)
          if (read !== undefined && !('error' in read)) content = read.bytes.toString('utf8')
        }
        if (content === '' || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
          const missing = content === '' && args.path !== undefined ? ` — no readable text file at "${args.path}"` : ''
          throw new Error(`content is required and at most ${String(MAX_CONTENT_BYTES / (1024 * 1024))} MB${missing}; pass the full content, or write the file first and pass its path`)
        }
        const language = kind === 'code' ? args.language?.trim() : undefined
        const ext = extensionFor(kind, language)
        const { path, version } = await writeVersion(cwd, relativeBase, id, ext, content)
        return {
          id,
          kind,
          title,
          ...(language === undefined || language === '' ? {} : { language }),
          path,
          version,
        }
      },
    }),
  )
}
