// Spawns packages/tool/data-studio-agent/python/bridge/admin_runner.py for
// the 2 admin actions that need real Python logic (DremioClient's actual
// HTTP calls to Dremio) — docs/data-studio-admin-ui-plan.md. Everything else
// in data-studio-db.ts is plain CRUD gateway does itself; only import/sync
// goes through Python. One process PER REQUEST (unlike
// packages/tool/data-studio-agent/src/kernel.ts's persistent-per-container
// kernel) — admin actions are rare button clicks, not a hot path.
//
// Gateway runs directly on the host (not inside infra/docker/worker's
// image), so `DATA_STUDIO_AGENT_DIR`/`FOX_PYTHON_DATA_STUDIO` (that image's
// own env vars) aren't set here — falls back to a relative path + `python3`,
// same "dev on this host works, a real prod deployment sets the env vars
// explicitly" trade-off packages/tool/python-repl's kernel already accepts.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { config } from './config.ts'

const SERVICE_DIR =
  process.env.DATA_STUDIO_AGENT_DIR ?? fileURLToPath(new URL('../../../packages/tool/data-studio-agent/python', import.meta.url))
// Real bug caught the hard way: a bare `python3` fallback silently picked up
// the HOST's system interpreter (no sqlmodel/agno/etc. installed there) —
// `ModuleNotFoundError: No module named 'sqlmodel'` on the very first real
// call. The venv `uv sync` creates alongside the bridge scripts is the
// correct local fallback (same directory layout the Docker image uses,
// just without that image's own FOX_PYTHON_DATA_STUDIO env var set).
const PYTHON = process.env.FOX_PYTHON_DATA_STUDIO ?? `${SERVICE_DIR}/.venv/bin/python`
const RUNNER = `${SERVICE_DIR}/bridge/admin_runner.py`

// Real gap caught testing the reindex-after-sync fix: `admin_runner.py`'s
// `main()` now also constructs `MeiliStore(settings)` (needed for `reindex_all`)
// — MEILISEARCH_* wasn't forwarded here at all before that, silently falling
// back to `Settings`' own defaults (which happen to match this repo's .env
// today, masking the gap) instead of whatever's actually configured.
const FORWARDED_ENV = [
  'PATH', 'HOME', 'LANG',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL_ID', 'OPENAI_EXTRA_BODY',
  'EMBEDDING_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL_ID',
  'DREMIO_URL', 'DREMIO_USERNAME', 'DREMIO_PASSWORD',
  'MEILISEARCH_URL', 'MEILISEARCH_MASTER_KEY', 'MEILISEARCH_SEMANTIC_RATIO',
] as const

export interface AdminBridgeReply {
  ok: boolean
  error?: string
  /** HTTP status the gateway should answer with when ok is false (400 bad input, 404 unknown id, 502 Dremio down). */
  status?: number
  sources?: { name: string; type: string }[]
  summary?: Record<string, number>
  // Only present on `op: "sync"` — admin_runner.py always reindexes right
  // after a successful sync (see that file's own module docstring for why).
  reindex_summary?: Record<string, number>
}

export function runAdminBridge(request: Record<string, unknown>, timeoutMs = 60_000): Promise<AdminBridgeReply> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {}
    for (const key of FORWARDED_ENV) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    // Same MongoDB data-studio-db.ts reads/writes directly (docs/data-studio-mongodb-plan.md) — passed
    // from gateway's resolved config so a Vault-injected `MongoDBWrite` reaches Python too.
    env.MONGODB_URL = config.mongodbUrl
    env.MONGODB_DATABASE_NAME = config.mongodbDatabaseName

    const child = spawn(PYTHON, ['-u', RUNNER], { cwd: SERVICE_DIR, env })
    let stderrTail = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`admin bridge timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        resolve(JSON.parse(line) as AdminBridgeReply)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`admin bridge exited (code ${code}) before replying.\n${stderrTail}`.trim()))
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.stdin.write(JSON.stringify(request) + '\n')
    child.stdin.end()
  })
}


// ---- the long-lived admin worker (quick calls) -------------------------------------------------------------
// One-shot processes (runAdminBridge above) are right for minutes-long jobs; for quick calls — the data-profile
// editor, the SQL console, dataset pickers — starting Python each time costs ~1.4 s (measured). This keeps one
// admin_runner.py alive and talks JSON lines with it, matching replies by `id`. It answers in order; a call that
// times out means the worker is stuck, so it is killed (every pending call fails) and the next call starts a
// fresh one.

interface Pending {
  resolve: (reply: AdminBridgeReply & Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let worker: ReturnType<typeof spawn> | undefined
const pending = new Map<number, Pending>()
let nextId = 1

function adminEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of FORWARDED_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.MONGODB_URL = config.mongodbUrl
  env.MONGODB_DATABASE_NAME = config.mongodbDatabaseName
  return env
}

function failAll(error: Error): void {
  for (const [id, call] of pending) {
    clearTimeout(call.timer)
    call.reject(error)
    pending.delete(id)
  }
}

function startWorker(): ReturnType<typeof spawn> {
  const child = spawn(PYTHON, ['-u', RUNNER], { cwd: SERVICE_DIR, env: adminEnv() })
  let stderrTail = ''
  child.stderr!.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let reply: AdminBridgeReply & { id?: number } & Record<string, unknown>
    try {
      reply = JSON.parse(line)
    } catch {
      return // a library printing to stdout: not a reply
    }
    const call = reply.id === undefined ? undefined : pending.get(reply.id)
    if (!call) return
    pending.delete(reply.id!)
    clearTimeout(call.timer)
    call.resolve(reply)
  })
  child.on('exit', (code) => {
    if (worker === child) worker = undefined
    failAll(new Error(`admin worker exited (code ${code}).\n${stderrTail}`.trim()))
  })
  child.on('error', (error) => {
    if (worker === child) worker = undefined
    failAll(error)
  })
  return child
}

/** One quick admin call on the long-lived worker. `id` is the reply correlation key, set here — a request field
 *  named `id` would be overwritten, so ops name theirs (`source_id`, …). */
export function callAdmin<T extends Record<string, unknown> = Record<string, unknown>>(
  request: Record<string, unknown> & { id?: never },
  timeoutMs = 60_000,
): Promise<AdminBridgeReply & T> {
  worker ??= startWorker()
  const child = worker
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`admin worker did not answer within ${timeoutMs / 1000}s`))
      if (worker === child) worker = undefined
      child.kill('SIGKILL') // stuck: the next call starts a fresh one
    }, timeoutMs)
    pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer })
    child.stdin!.write(JSON.stringify({ ...request, id }) + '\n')
  })
}

/** Stop the worker (gateway shutdown). */
export function stopAdminWorker(): void {
  worker?.kill('SIGTERM')
  worker = undefined
}
