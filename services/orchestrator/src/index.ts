// Spawn, hibernate, rehydrate, TTL, warm pool (roadmap §1.2). Must never know
// session content — only affinity/lifecycle. Also owns materializing
// $DSH_HOME/profiles/fox-harness/ from @fox-harness/profile-template at
// first boot (docs/code-rules.md §0.4) — that's control-plane config work,
// not something dsh does on its own.

import { timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import type {
  EnsureSessionRequest,
  EnsureSessionResponse,
  ProjectPromoteRequest,
  SkillsSyncRequest,
  SkillsSyncResponse,
  WorkspaceFilesResponse,
} from '@fox-harness/contracts'

import type { ModelsResponse } from '@fox-harness/contracts'

import { purgeSession, removeTree } from './archive.ts'
import { config } from './config.ts'
import { removeWorker } from './docker.ts'
import { ensureSession } from './ensure.ts'
import { InvalidFlowError, InvalidModelError, QuotaExceededError } from './errors.ts'
import { deleteSession, getSession, touch } from './redis.ts'
import { isValidSkillName, syncSkills } from './skills-sync.ts'
import {
  contentTypeFor,
  listWorkspaceFiles,
  projectDirFor,
  promoteOutput,
  resolveInside,
  saveUpload,
  UploadTooLargeError,
  workspaceDirFor,
} from './workspace-files.ts'
import { startIdleSweep } from './sweep.ts'
import { replenishWarmPool } from './warmpool.ts'

const ENSURE_PATH = /^\/sessions\/([^/]+)\/ensure$/
const TOUCH_PATH = /^\/sessions\/([^/]+)\/touch$/
const PURGE_PATH = /^\/sessions\/([^/]+)$/
const MODELS_PATH = /^\/models$/
// Files of a data-analysis chat, or of a project (shared by its chats).
const WORKSPACE_FILES_PATH = /^\/(sessions|projects)\/([^/]+)\/files$/
const WORKSPACE_FILE_PATH = /^\/(sessions|projects)\/([^/]+)\/files\/(.+)$/
const PROJECT_PATH = /^\/projects\/([^/]+)$/
const PROJECT_PROMOTE_PATH = /^\/projects\/([^/]+)\/promote$/
// A bare, visible file name — uploads always land at the top of the working directory.
const UPLOAD_NAME_RE = /^[^/\\.][^/\\]{0,199}$/

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

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
        const body: EnsureSessionResponse = await ensureSession(sessionId, parsed.model, parsed.flow, parsed.projectId)
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
        if (error instanceof InvalidFlowError) {
          log('ensure_invalid_flow', { sessionId, reason: error.message })
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
      try {
        const record = await getSession(sessionId)
        if (!record) return sendJson(res, 404, { error: 'unknown session' })
        if (record.status === 'running') await removeWorker(record.containerId)
        await purgeSession(record.dshHomeDir, config.archiveDir, sessionId)
        await deleteSession(sessionId)
        log('purge_ok', { sessionId })
        res.writeHead(204)
        res.end()
      } catch (error) {
        log('purge_failed', { sessionId, error: String(error) })
        sendJson(res, 500, { error: 'purge failed' })
      }
    })()
    return
  }

  // Working-directory files (workspace-files.ts) of a data-analysis session or a
  // project: GET …/files lists, PUT …/files/<name> uploads, GET …/files/<path> downloads.
  const filesMatch = WORKSPACE_FILES_PATH.exec(url.pathname)
  const fileMatch = WORKSPACE_FILE_PATH.exec(url.pathname)
  if ((filesMatch && req.method === 'GET') || (fileMatch && (req.method === 'GET' || req.method === 'PUT'))) {
    void (async () => {
      const [, kind, id] = (filesMatch ?? fileMatch)!
      const owner = kind === 'projects' ? { projectId: id } : { sessionId: id }
      const dir = kind === 'projects' ? projectDirFor(id) : await workspaceDirFor(id)
      if (!dir) return sendJson(res, 404, { error: 'no working directory' })
      if (filesMatch) {
        const body: WorkspaceFilesResponse = { files: await listWorkspaceFiles(dir) }
        return sendJson(res, 200, body)
      }
      const relativePath = decodeURIComponent(fileMatch![3])
      if (req.method === 'PUT') {
        if (!UPLOAD_NAME_RE.test(relativePath)) return sendJson(res, 400, { error: 'invalid file name' })
        try {
          await saveUpload(dir, relativePath, req)
          log('workspace_upload_ok', owner)
          return sendJson(res, 201, { path: relativePath })
        } catch (error) {
          if (error instanceof UploadTooLargeError) return sendJson(res, 413, { error: error.message })
          log('workspace_upload_failed', { ...owner, error: String(error) })
          return sendJson(res, 500, { error: 'upload failed' })
        }
      }
      const target = resolveInside(dir, relativePath)
      const info = target ? await stat(target).catch(() => undefined) : undefined
      if (!target || !info?.isFile()) return sendJson(res, 404, { error: 'file not found' })
      res.writeHead(200, { 'content-type': contentTypeFor(target), 'content-length': info.size })
      createReadStream(target).pipe(res)
    })()
    return
  }

  // A project's shared folder; gateway has already purged the project's chats.
  const projectMatch = PROJECT_PATH.exec(url.pathname)
  if (req.method === 'DELETE' && projectMatch) {
    void (async () => {
      const projectId = projectMatch[1]
      const dir = projectDirFor(projectId)
      if (!dir) return sendJson(res, 404, { error: 'invalid project id' })
      try {
        await removeTree(dir)
        log('project_delete_ok', { projectId })
        res.writeHead(204)
        res.end()
      } catch (error) {
        log('project_delete_failed', { projectId, error: String(error) })
        sendJson(res, 500, { error: 'project delete failed' })
      }
    })()
    return
  }

  // Copy a chat's output into the project's shared outputs/ folder (gateway has
  // already checked that the chat belongs to the project).
  const promoteMatch = PROJECT_PROMOTE_PATH.exec(url.pathname)
  if (req.method === 'POST' && promoteMatch) {
    void (async () => {
      const projectId = promoteMatch[1]
      try {
        const body = JSON.parse(await readBody(req)) as ProjectPromoteRequest
        const dir = projectDirFor(projectId)
        const path = dir && typeof body.sessionId === 'string' && typeof body.path === 'string'
          ? await promoteOutput(dir, body.sessionId, body.path)
          : undefined
        if (!path) return sendJson(res, 404, { error: 'output not found' })
        log('project_promote_ok', { projectId, sessionId: body.sessionId })
        sendJson(res, 201, { path })
      } catch (error) {
        log('project_promote_failed', { projectId, error: String(error) })
        sendJson(res, 500, { error: 'promote failed' })
      }
    })()
    return
  }

  // Per-user skills (docs/skill-transfer-plan.md): gateway sends session ids
  // + files, this writes them into each session's $DSH_HOME/skills.
  if (req.method === 'PUT' && url.pathname === '/skills-sync') {
    void (async () => {
      let body: SkillsSyncRequest
      try {
        body = JSON.parse(await readBody(req)) as SkillsSyncRequest
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON body' }))
        return
      }
      if (!Array.isArray(body.sessionIds) || !Array.isArray(body.skills) || body.skills.some((skill) => !isValidSkillName(skill.name))) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'sessionIds and skills with valid names are required' }))
        return
      }
      try {
        const response: SkillsSyncResponse = { synced: await syncSkills(body.sessionIds, body.skills) }
        log('skills_sync_ok', { synced: response.synced, skills: body.skills.length })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response))
      } catch (error) {
        log('skills_sync_failed', { error: String(error) })
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'skills sync failed' }))
      }
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
