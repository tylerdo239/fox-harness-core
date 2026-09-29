import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

// Local alias instead of pulling in @deepseek-ai/dsh-session just for a type —
// this package's only real dependency is @deepseek-ai/dsh-tools.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// infra/docker/worker/Dockerfile sets both for the real image: a dedicated venv
// (Agno/SQLGlot/chromadb — pyproject.toml pins Python 3.12, which the base
// image's own apt-installed python3 doesn't provide) and the vendored code's
// directory (./python, a sibling of this package's own src/ — same layout
// packages/tool/python-repl uses for its own runner.py). The fallback is for
// local/host-profile dev only. Real bug caught the hard way testing
// services/gateway's OWN admin bridge (data-studio-bridge.ts, same fallback
// pattern): a bare `python3` fallback silently picks up the HOST's system
// interpreter (no sqlmodel/agno/etc. installed there) — the local venv
// `uv sync` creates alongside the bridge scripts is the correct fallback.
const SERVICE_DIR = process.env.DATA_STUDIO_AGENT_DIR ?? fileURLToPath(new URL('../python', import.meta.url))
const PYTHON = process.env.FOX_PYTHON_DATA_STUDIO ?? `${SERVICE_DIR}/.venv/bin/python`
const RUNNER = `${SERVICE_DIR}/bridge/runner.py`

// Env vars forwarded from the worker container into the subprocess — unlike
// python-repl's PythonKernel (which deliberately gives model-written code a
// minimal env with no API keys), this subprocess runs OUR OWN vetted bridge
// script, which needs real credentials to reach the LLM/embedding/Dremio/
// Meilisearch endpoints itself.
const FORWARDED_ENV = [
  'PATH', 'HOME', 'LANG',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL_ID', 'OPENAI_EXTRA_BODY',
  'EMBEDDING_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL_ID',
  'DREMIO_URL', 'DREMIO_USERNAME', 'DREMIO_PASSWORD',
  'MEILISEARCH_URL', 'MEILISEARCH_MASTER_KEY', 'MEILISEARCH_SEMANTIC_RATIO',
  // MongoDB holding the shared semantic layer + chat history (docs/data-studio-mongodb-plan.md) —
  // forwarded to every worker container by services/orchestrator (config.ts workerEnvPassthrough).
  'MONGODB_URL', 'MongoDBWrite', 'MONGODB_DATABASE_NAME',
] as const

export interface AnalyzeReply {
  ok: boolean
  error?: string
  answer?: string
  sql?: string | null
  columns?: string[]
  rows?: Record<string, JsonValue>[]
  row_count?: number
  trace_md?: string
  chart?: Record<string, JsonValue> | null
  // docs/data-studio-admin-ui-plan.md phase 5 — the real Chart document's id (uuid string,
  // `charts` collection), when `chart` is
  // present. Lets the FE offer "pin to dashboard" without the bridge doing
  // anything HTTP-shaped — a dashboard widget just references this id.
  chart_id?: string | null
  // Every visual chart of the answer (recommended first), each carrying its own rows and, once
  // persisted, its own `chart_id` — so the UI can offer a type switcher and pin any of them.
  charts?: { type: string; x: string | null; y: string[]; title: string; recommended: boolean; rows: Record<string, JsonValue>[]; chart_id?: string | null }[]
  follow_up_questions?: string[]
  assumptions?: string[]
  truncated?: boolean
}

// One persistent process per worker container (i.e. per session), started
// lazily on the first call and reused across turns — avoids paying Python
// startup + import cost (agno/sqlglot/chromadb) on every question.
export class DataStudioKernel {
  private process: ChildProcessWithoutNullStreams | undefined
  private reply: ((reply: AnalyzeReply | undefined) => void) | undefined
  private stderrTail = ''

  async ask(question: string, timeoutMs: number, signal: AbortSignal): Promise<AnalyzeReply> {
    const process = this.process ?? this.start()

    const reply = await new Promise<AnalyzeReply | 'timeout' | 'aborted' | undefined>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs)
      const onAbort = () => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
      this.reply = (value) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      process.stdin.write(JSON.stringify({ question }) + '\n')
    })
    this.reply = undefined

    if (reply === 'timeout' || reply === 'aborted') {
      this.stop()
      throw new Error(
        reply === 'timeout'
          ? `Data analysis ran longer than ${timeoutMs / 1000} seconds and was stopped.`
          : 'Cancelled; the data analysis process was stopped.',
      )
    }
    if (reply === undefined) {
      throw new Error(`The data-studio-agent process exited unexpectedly.\n${this.stderrTail}`.trim())
    }
    return reply
  }

  stop(): void {
    this.process?.kill('SIGKILL')
    this.process = undefined
  }

  private start(): ChildProcessWithoutNullStreams {
    const env: Record<string, string> = {}
    for (const key of FORWARDED_ENV) {
      const value = globalThis.process.env[key]
      if (value !== undefined) env[key] = value
    }

    const child = spawn(PYTHON, ['-u', RUNNER], { cwd: SERVICE_DIR, env })
    this.stderrTail = ''
    // runner.py's on_event prints one JSON progress line per pipeline milestone
    // (agent_started/done, tool_started/done, sub_started/done, result, ...) —
    // forward each straight to this worker container's own stdout so `docker logs
    // -f` shows live progress while analyze_data is running, not just the final
    // reply minutes later. stderrTail keeps buffering for the "process exited
    // unexpectedly" error message above.
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderrTail = (this.stderrTail + line + '\n').slice(-2000)
      // Most lines are runner.py's on_event JSON (flatten into the log record);
      // anything else (e.g. a stray Python traceback/logging line) is passed
      // through as-is under `line` rather than dropped.
      let fields: Record<string, unknown>
      try {
        fields = { ...(JSON.parse(line) as Record<string, unknown>) }
      } catch {
        fields = { line }
      }
      console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'data-studio-agent', ...fields }))
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.reply?.(JSON.parse(line) as AnalyzeReply)
    })
    child.on('exit', () => {
      if (this.process === child) this.process = undefined
      this.reply?.(undefined)
    })
    this.process = child
    return child
  }
}
