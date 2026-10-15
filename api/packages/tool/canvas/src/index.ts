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
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

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

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_write',
      description: [
        'Push a long, self-contained code file or markdown document into a side "Canvas" panel',
        'next to the chat, instead of writing it inline. Use it for a full source file the user',
        'will keep copying or editing, or a long report/guide/article — not for short snippets or',
        'anything that belongs in the reply itself (roughly: under ~20 lines or a couple of short',
        'paragraphs stays inline). Call again with the SAME id to update/replace that canvas',
        '(e.g. after the user asks for a change) — a different id opens a separate one alongside it.',
        'For a website, web app, dashboard, or any UI the user should see rendered, not just read as',
        'code: use kind:"code", language:"html", and write ONE self-contained HTML file (CSS in a',
        '<style> tag, JS in a <script> tag, a CDN <script src="https://..."> for any library you need',
        '— no separate .css/.js files, no build step). The panel renders it live in an iframe the user',
        'can look at immediately, with a Code tab to inspect the source — this is strictly better here',
        'than writing files with the filesystem tool, which only offers a download.',
        'For an Excel, Word or PDF deliverable (the user asks to "xuất/format ra excel", "làm file word",',
        '"xuất pdf", or the content is a table meant for calculation / a formal document to send):',
        'first write the real file into the working directory with python (openpyxl or pandas for .xlsx,',
        '.csv; a matplotlib figure saved as .pdf), then call this tool with kind:"file" and `path` set to',
        'that file (no `content`) — the panel renders a live spreadsheet / document / PDF preview with a',
        'download button. Always do this second step: a file only written with python is invisible in',
        'the panel. Supported: .xlsx, .csv, .docx, .pdf (no Word/PDF writing library is installed: a',
        '.docx/.pdf works when the file already exists, e.g. one the user uploaded). Give each FORMAT its own',
        'id (e.g. "bao-gia-xlsx", "bao-gia-pdf"): the same id is for new versions of the same file,',
        'so the user can switch between the Excel and the PDF instead of one replacing the other.',
        'Updating an id that already exists is a PATCH, not a rewrite: read its current file first',
        '(the `path` your own last call for that id returned) with the read tool, then return that',
        'exact content with only the requested change applied — same colors, layout, structure and',
        'style everywhere else. Do not regenerate it from scratch or restyle it unless the user asked for that.',
      ].join(' '),
      parameters: {
        id: {
          type: 'string',
          description: `kebab-case slug identifying this canvas across turns, e.g. "main" or "weekly-report". Reuse it to update the same canvas (read its current file first — see above); a new id opens an additional one. Defaults to the title as a slug.`,
        },
        kind: {
          type: 'string',
          required: true,
          enum: ['code', 'markdown', 'file'] as const,
          description: '"code" for a source file (pair with `language`; use language:"html" for anything the user should SEE rendered — it gets a live preview), "markdown" for a document meant to be read/edited as prose, "file" for an .xlsx/.csv/.docx/.pdf you already wrote into the working directory (pass `path`, not `content`).',
        },
        title: {
          type: 'string',
          required: true,
          description: `Short human-readable title shown as the panel header, e.g. "Weekly sales report" or "invoice_parser.py". At most ${String(MAX_TITLE_CHARS)} characters.`,
        },
        language: {
          type: 'string',
          description: 'For kind:"code" only — a short language name (e.g. "html", "typescript", "python", "json", "bash") used to pick a file extension, syntax-highlight the panel, and — for "html" specifically — render a live preview. Ignored for kind:"markdown".',
        },
        content: {
          type: 'string',
          description: 'For kind:"code"/"markdown" (required there): the full content to show in the canvas. Omit for kind:"file".',
        },
        path: {
          type: 'string',
          description: 'For kind:"file" (required there): path of an existing .xlsx/.csv/.docx/.pdf in the working directory, e.g. "bao-cao.xlsx". A text file (.html, .md, .py, .json …) is accepted too and opens as a code/markdown canvas. For kind:"code"/"markdown", a path with no `content` is read from that file.',
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
        const outDir = output === undefined ? cwd : join(cwd, output)
        const relativeBase = output === undefined ? '' : `${output.replace(/\/+$/, '')}/`

        if (kind === 'file') {
          const requested = args.path?.trim() ?? ''
          if (requested === '') throw new Error('kind:"file" needs `path`: the .xlsx/.csv/.docx/.pdf you wrote into the working directory')
          const source = insideCwd(cwd, requested)
          if (source === undefined) throw new Error(`path "${requested}" is outside the working directory`)
          const ext = extname(source).toLowerCase()
          const info = await stat(source).catch(() => undefined)
          if (info === undefined || !info.isFile()) throw new Error(`no file at "${requested}" — write it first (e.g. with python), then call canvas_write`)

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
            if (info.size === 0 || info.size > MAX_CONTENT_BYTES) {
              throw new Error(`file must be non-empty and at most ${String(MAX_CONTENT_BYTES / (1024 * 1024))} MB for a text canvas`)
            }
            const content = await readFile(source, 'utf8')
            await mkdir(outDir, { recursive: true })
            const version = await nextVersion(outDir, id)
            const path = `${relativeBase}canvas-${id}-v${String(version)}${ext}`
            await writeFile(join(cwd, path), content, 'utf8')
            return {
              id,
              kind: textKind.kind,
              title,
              ...(textKind.language === undefined ? {} : { language: textKind.language }),
              path,
              version,
            }
          }
          if (info.size === 0 || info.size > MAX_FILE_BYTES) {
            throw new Error(`file must be non-empty and at most ${String(MAX_FILE_BYTES / (1024 * 1024))} MB`)
          }
          await mkdir(outDir, { recursive: true })
          const version = await nextVersion(outDir, id)
          const path = `${relativeBase}canvas-${id}-v${String(version)}${ext}`
          await copyFile(source, join(cwd, path))
          return { id, kind, title, path, version }
        }

        // kind:code / kind:markdown — a missing `content` with a `path` to a
        // text file is read instead of failing (same measured detour as above).
        let content = args.content ?? ''
        if (content === '' && args.path !== undefined) {
          const source = insideCwd(cwd, args.path.trim())
          const info = source === undefined ? undefined : await stat(source).catch(() => undefined)
          if (source !== undefined && info !== undefined && info.isFile() && info.size > 0 && info.size <= MAX_CONTENT_BYTES) {
            content = await readFile(source, 'utf8')
          }
        }
        if (content === '' || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
          const missing = content === '' && args.path !== undefined ? ` — no readable text file at "${args.path}"` : ''
          throw new Error(`content is required and at most ${String(MAX_CONTENT_BYTES / (1024 * 1024))} MB${missing}; pass the full content, or write the file first and pass its path`)
        }
        const language = kind === 'code' ? args.language?.trim() : undefined
        const ext = extensionFor(kind, language)
        await mkdir(outDir, { recursive: true })
        const version = await nextVersion(outDir, id)
        const path = `${relativeBase}canvas-${id}-v${String(version)}${ext}`
        await writeFile(join(cwd, path), content, 'utf8')
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
