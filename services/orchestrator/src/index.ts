// Spawn, hibernate, rehydrate, TTL, warm pool (roadmap §1.2). Must never know
// session content — only affinity/lifecycle. Also owns materializing
// $DSH_HOME/profiles/fox-harness/ from @fox-harness/profile-template at
// first boot (docs/code-rules.md §0.4) — that's control-plane config work,
// not something dsh does on its own.

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'

import type { EnsureSessionRequest, EnsureSessionResponse } from '@fox-harness/contracts'

import type { ModelsResponse } from '@fox-harness/contracts'

import { purgeSession } from './archive.ts'
import { config } from './config.ts'
import { removeWorker } from './docker.ts'
import { ensureSession } from './ensure.ts'
import { InvalidModelError, QuotaExceededError } from './errors.ts'
import { deleteSession, getSession, touch } from './redis.ts'
import { startIdleSweep } from './sweep.ts'
import { replenishWarmPool } from './warmpool.ts'

const ENSURE_PATH = /^\/sessions\/([^/]+)\/ensure$/
const TOUCH_PATH = /^\/sessions\/([^/]+)\/touch$/
const PURGE_PATH = /^\/sessions\/([^/]+)$/
const MODELS_PATH = /^\/models$/

// Phase 6 checklist item 2: cross-layer telemetry, tagged with sessionId.
// Plain structured stdout JSON — not a tracing backend (out of scope for a
// dev-scope project, and the roadmap only asks for "gắn sessionId", which
// grep-across-service-logs already satisfies). Duplicated per-service
// rather than imported from a shared package, matching this project's
// established "mirrored, not imported" convention for small cross-boundary
// utilities (docs/code-rules.md) — see services/gateway and
// services/plugin-registry for the same ~6-line function.
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'orchestrator', event, ...fields }))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Security fix 2026-09-09: this service otherwise has ZERO auth on any
// route (docs/security-performance-review-2026-09-09.md finding #1) —
// dockerode-level lifecycle control (spawn/purge/etc.) reachable by anyone
// who can reach the port, no identity needed. NOT per-user auth (this
// service still never learns who a user is, roadmap's explicit boundary) —
// just proves the caller really is services/gateway. `timingSafeEqual`
// (same primitive services/gateway/src/password.ts already uses) so this
// check doesn't itself become a new timing side-channel on the secret.
function isValidInternalSecret(req: IncomingMessage): boolean {
  const provided = req.headers['x-fox-harness-internal-secret']
  if (typeof provided !== 'string') return false
  const expected = Buffer.from(config.internalSecret)
  const actual = Buffer.from(provided)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

const server = createServer((req, res) => {
  if (!isValidInternalSecret(req)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')

  const ensureMatch = ENSURE_PATH.exec(url.pathname)
  if (req.method === 'POST' && ensureMatch) {
    void (async () => {
      const sessionId = ensureMatch[1]
      try {
        const raw = await readBody(req)
        const parsed = raw ? (JSON.parse(raw) as EnsureSessionRequest) : {}
        const body: EnsureSessionResponse = await ensureSession(sessionId, parsed.model)
        log('ensure_ok', { sessionId, host: body.host, port: body.port })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          log('ensure_quota_rejected', { sessionId, reason: error.message })
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: error.message }))
          return
        }
        if (error instanceof InvalidModelError) {
          log('ensure_invalid_model', { sessionId, reason: error.message })
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: error.message }))
          return
        }
        console.error('[orchestrator] ensure failed:', error)
        log('ensure_failed', { sessionId, error: String(error) })
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      }
    })()
    return
  }

  const touchMatch = TOUCH_PATH.exec(url.pathname)
  if (req.method === 'POST' && touchMatch) {
    void (async () => {
      await readBody(req)
      await touch(touchMatch[1])
      res.writeHead(204)
      res.end()
    })()
    return
  }

  // Phase 6 checklist item 4: real delete-on-request. Stops the container if
  // one is live, then removes both the on-disk directory/archive tarball
  // (archive.ts's purgeSession — the actual erasure) and the Redis affinity
  // record. Irreversible: unlike hibernate/archive, nothing can rehydrate a
  // purged session afterward — a fresh `ensure` on the same id just creates
  // a brand-new one.
  const purgeMatch = PURGE_PATH.exec(url.pathname)
  if (req.method === 'DELETE' && purgeMatch) {
    void (async () => {
      const sessionId = purgeMatch[1]
      const record = await getSession(sessionId)
      if (!record) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unknown session' }))
        return
      }
      if (record.status === 'running') await removeWorker(record.containerId)
      await purgeSession(record.dshHomeDir, config.archiveDir, sessionId)
      await deleteSession(sessionId)
      log('purge_ok', { sessionId })
      res.writeHead(204)
      res.end()
    })()
    return
  }

  // Phase 12 item 4: the model allow-list a session can be created with —
  // static config, not session-scoped, so no auth/ownership check belongs
  // here (services/gateway proxies this byte-blind, same as plugin-registry).
  if (req.method === 'GET' && MODELS_PATH.test(url.pathname)) {
    const body: ModelsResponse = { models: config.allowedModels }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

void replenishWarmPool()
startIdleSweep()

server.listen(config.port, () => {
  console.log(`[orchestrator] listening on http://127.0.0.1:${config.port}, worker image ${config.workerImage}`)
})
