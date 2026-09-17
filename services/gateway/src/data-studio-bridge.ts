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
    // Same shared sqlite file data-studio-db.ts reads/writes directly —
    // computed here (not forwarded) since gateway's own env has no
    // DATABASE_URL of its own (that name is MariaDB's, config.databaseUrl).
    env.DATABASE_URL = `sqlite:////${config.dataStudioSharedDir.replace(/^\//, '')}/semantic_layer.db`

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
