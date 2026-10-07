// Auth, token issuance, routing + affinity, streaming fan-out (roadmap
// §1.2). MUST NOT import from any `@fox-harness/dsh-*` package (docs/code-rules.md
// §1). Must never run agent logic itself: this process only issues tokens and
// relays raw WS frames to the core's transport (packages/agent-core/src/transport,
// see proxy.ts) — which has no auth of its own and expects to sit behind exactly this.
//
// Phase 7: real accounts + 2 roles (admin, user), replacing the single
// shared-operator-secret model Phase 2-6 used. Gateway is the SOLE
// authorization enforcer (docs/agent-core-architecture-roadmap.md's Phase 7
// architecture decision) — the agent runtime does no auth checks of its
// own, same as before; every route below now resolves a real identity and
// checks it before proxying anywhere.

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { WebSocketServer } from 'ws'

import {
  changeUser,
  login,
  logout,
  register,
  resolveIdentity,
  type AuthedIdentity,
  issueWsTicket,
  redeemWsTicket,
} from './auth.ts'
import { config } from './config.ts'
import {
  countCustomSkills,
  createCustomSkill,
  createProject,
  createSession,
  deleteCustomSkill,
  deleteProjectRow,
  deleteSessionRow,
  getProjectOwnerId,
  getSessionOwnerId,
  getSessionRuntimeInfo,
  getUserById,
  listSessionPlacementsForOwner,
  listCustomSkills,
  listProjectsForOwner,
  listSessionIdsForOwner,
  listSessionIdsForProject,
  listSessionOwners,
  listSessionsForOwner,
  listSessionsForProject,
  listUsers,
  markSessionFirstMessage,
  renameProject,
  renameSession,
  touchSessionRow,
  updateCustomSkill,
  type Role,
  type TitleSource,
} from './db.ts'
import {
  addWidget,
  availableCharts,
  createDashboard,
  createGlossaryTerm,
  createMetric,
  createRelationship,
  deleteDashboard,
  deleteGlossaryTerm,
  deleteMetric,
  deleteRelationship,
  getDashboard,
  getDataSource,
  getEntity,
  getEntityColumn,
  listBrowseEntities,
  listColumnsForEntity,
  listDashboards,
  listDataSources,
  listEntitiesForSource,
  listGlossaryTerms,
  listMetrics,
  listRelationships,
  pinChart,
  saveWidgets,
  updateChart,
  updateDashboard,
  updateDataSource,
  updateEntity,
  updateEntityColumn,
  updateGlossaryTerm,
  updateMetric,
  updateRelationship,
  type MetricInput,
  type RelationshipInput,
} from './data-studio-db.ts'
import { callAdmin, runAdminBridge, stopAdminWorker } from './data-studio-bridge.ts'
import { isLive, liveCount, track as trackConnection, checkQuota } from './runtime/live.ts'
import { ensurePlacement, isUuid, placementFor, projectDirFor } from './runtime/paths.ts'
import { deleteProjectData, purgeSessionData, workspaceDirForSession } from './runtime/sessions.ts'
import { ensureLocal as ensureSessionLogLocal, startArchiver, stopArchiver } from './runtime/session-archive.ts'
import { syncSkills } from './runtime/skills-sync.ts'
import { RuntimeSupervisor } from './runtime/supervisor.ts'
import {
  contentTypeFor,
  listWorkspaceFiles,
  promoteOutput,
  resolveInside,
  saveUpload,
  UploadTooLargeError,
} from './runtime/workspace-files.ts'
import { checkMongoConnection, ensureIndexes } from './mongo.ts'
import { proxyToWorker } from './proxy.ts'
import { checkRateLimit, renewTokenHash } from './redis.ts'
import { loadBuiltinSkills, MAX_SKILLS_PER_USER, validateSkill } from './skills.ts'

// Phase 6 checklist item 2: cross-layer telemetry, tagged with sessionId.
// Same structured-JSON-to-stdout convention duplicated in
// the runtime (see packages/agent-core/src/transport/server.ts: this isn't a
// shared import).
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'gateway', event, ...fields }))
}

// Security fix 2026-09-09: every real sessionId this repo ever produces is
// a `randomUUID()` output (WS upgrade handler, brand-new session branch) —
// this matches that exact shape. Applied at every entry point that reads a
// sessionId out of the URL path before it touches the DB or (via
// the runtime) the filesystem, rejecting anything else with a real 400 —
// a malformed id (e.g. containing `../`) used to be able to reach
// `path.join(config.dataDir, sessionId)`.
// The agent runtime(s) this process starts and routes to (runtime/supervisor.ts).
const runtime = new RuntimeSupervisor()

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PLUGIN_INVENTORY_PATH = /^\/sessions\/([^/]+)\/plugin-inventory$/
// Phase 6 checklist item 4: real delete-on-request.
const SESSION_PURGE_PATH = /^\/sessions\/([^/]+)$/
// Phase 12 item 2: matched BEFORE SESSION_PURGE_PATH below since both would
// otherwise match /sessions/mine — 'mine' is never a real session id (ids
// are randomUUID(), see the WS upgrade handler), but matching it against the
// wrong route first would 404 through the wrong path with a worse error.
const SESSION_MINE_PATH = /^\/sessions\/mine$/
const SESSION_RENAME_PATH = /^\/sessions\/([^/]+)$/
const MODELS_PATH = /^\/models$/
const CUSTOM_SKILL_PATH = /^\/custom-skills\/([^/]+)$/
// Data-analysis working directory (docs/rlm-transfer-plan.md giai đoạn 4) of a
// chat, or of a project (9.1) — shared by that project's chats.
// An upload's file name: no path separators, no leading dot.
const UPLOAD_NAME_RE = /^[^/\\.][^/\\]{0,199}$/
const WORKSPACE_FILES_PATH = /^\/(sessions|projects)\/([^/]+)\/files(?:\/(.+))?$/
// Projects (docs/rlm-transfer-plan.md 9.1). Project ids are UUIDs, the same
// shape SESSION_ID_RE checks.
const PROJECTS_PATH = /^\/projects$/
const PROJECT_PATH = /^\/projects\/([^/]+)$/
const PROJECT_SESSIONS_PATH = /^\/projects\/([^/]+)\/sessions$/
const PROJECT_PROMOTE_PATH = /^\/projects\/([^/]+)\/promote$/
// docs/data-studio-admin-ui-plan.md — semantic-layer admin CRUD (Data
// Sources section). Plain numeric ids (SQLModel `Field(primary_key=True)`
// autoincrement ints), not UUIDs like sessions/projects.
const DATA_STUDIO_SOURCE_PATH = /^\/data-studio\/sources\/([^/]+)$/
const DATA_STUDIO_SOURCE_ENTITIES_PATH = /^\/data-studio\/sources\/([^/]+)\/entities$/
const DATA_STUDIO_ENTITY_PATH = /^\/data-studio\/entities\/([^/]+)$/
const DATA_STUDIO_ENTITY_COLUMNS_PATH = /^\/data-studio\/entities\/([^/]+)\/columns$/
const DATA_STUDIO_COLUMN_PATH = /^\/data-studio\/columns\/([^/]+)$/
const DATA_STUDIO_GLOSSARY_PATH = /^\/data-studio\/glossary$/
const DATA_STUDIO_GLOSSARY_TERM_PATH = /^\/data-studio\/glossary\/([^/]+)$/
const DATA_STUDIO_BROWSE_ENTITIES_PATH = /^\/data-studio\/browse-entities$/
const DATA_STUDIO_RELATIONSHIPS_PATH = /^\/data-studio\/relationships$/
const DATA_STUDIO_RELATIONSHIP_PATH = /^\/data-studio\/relationships\/([^/]+)$/
const DATA_STUDIO_METRICS_PATH = /^\/data-studio\/metrics$/
const DATA_STUDIO_METRIC_PATH = /^\/data-studio\/metrics\/([^/]+)$/
const DATA_STUDIO_DREMIO_BROWSE_PATH = /^\/data-studio\/dremio\/browse$/
const DATA_STUDIO_DREMIO_SYNC_PATH = /^\/data-studio\/dremio\/sync$/
const DATA_STUDIO_DREMIO_DATASETS_PATH = /^\/data-studio\/dremio\/sources\/([^/]+)\/datasets$/
// the reference's data profile (/data-profile/*), served by bridge/admin_runner.py's `data_profile` op
const DATA_STUDIO_PROFILE_PATH = /^\/data-studio\/profile(\/.*)$/
const DATA_STUDIO_DASHBOARDS_PATH = /^\/data-studio\/dashboards$/
const DATA_STUDIO_DASHBOARD_PATH = /^\/data-studio\/dashboards\/([^/]+)$/
const DATA_STUDIO_DASHBOARD_WIDGETS_PATH = /^\/data-studio\/dashboards\/([^/]+)\/widgets$/
const DATA_STUDIO_DASHBOARD_CHARTS_PATH = /^\/data-studio\/dashboards\/([^/]+)\/charts$/
const DATA_STUDIO_AVAILABLE_CHARTS_PATH = /^\/data-studio\/dashboards\/meta\/available-charts$/
const DATA_STUDIO_CHART_PATH = /^\/data-studio\/charts\/([^/]+)$/
const PROJECT_NAME_MAX = 120

const builtinSkills = loadBuiltinSkills()
const builtinSkillNames = new Set(builtinSkills.map((skill) => skill.name))

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Every async route runs through this: a rejected handler (MariaDB, Redis or Mongo unreachable, a bug) answers
// that ONE request with 500 instead of becoming an unhandled rejection that takes the whole gateway (and every
// live chat) down.
function handle(res: ServerResponse, run: () => Promise<unknown>): void {
  run().catch((error: unknown) => {
    log('route_failed', { error: error instanceof Error ? error.message : String(error) })
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    else res.end()
  })
}

// Shared by POST /data-studio/relationships and PATCH /data-studio/relationships/:id
// — same shape either way. Sends its own 400 and returns undefined on any
// validation failure, so callers can `if (!input) return` without duplicating
// the error response.
async function parseRelationshipInput(req: IncomingMessage, res: ServerResponse): Promise<RelationshipInput | undefined> {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' })
    return undefined
  }
  const { from_entity_id, to_entity_id, cardinality, join_type_default, column_pairs } = body
  const pairsValid =
    Array.isArray(column_pairs) &&
    column_pairs.length > 0 &&
    column_pairs.every(
      (pair) =>
        pair && typeof pair === 'object' && typeof pair.from_column_id === 'string' && typeof pair.to_column_id === 'string',
    )
  if (
    typeof from_entity_id !== 'string' ||
    typeof to_entity_id !== 'string' ||
    typeof cardinality !== 'string' ||
    typeof join_type_default !== 'string' ||
    !pairsValid
  ) {
    sendJson(res, 400, {
      error: 'from_entity_id, to_entity_id, cardinality, join_type_default, and at least 1 column_pairs entry are required',
    })
    return undefined
  }
  return { from_entity_id, to_entity_id, cardinality, join_type_default, column_pairs }
}

// Writes the owner's current skills into the working directory of each given session (`<cwd>/.dsh/skills`,
// runtime/skills-sync.ts). A failure is logged, not surfaced: the skill is already saved in MariaDB, and the
// next WS connect syncs again.
async function pushSkills(ownerId: number, sessions: { sessionId: string; projectId: string | undefined }[]): Promise<void> {
  if (sessions.length === 0) return
  try {
    const skills = (await listCustomSkills(ownerId)).map(({ name, description, content }) => ({ name, description, content }))
    const cwds = sessions.map(({ sessionId, projectId }) => placementFor({ ownerId, projectId }, sessionId).cwd)
    for (const cwd of new Set(cwds)) await mkdir(cwd, { recursive: true })
    const synced = await syncSkills(cwds, skills)
    log('skills_sync_ok', { ownerId, synced, skills: skills.length })
  } catch (error) {
    log('skills_sync_failed', { ownerId, error: String(error) })
  }
}

// 2026-10-06: request bodies were read into memory with no cap (measured: 4 x 75 MB from one user took the backend
// from 430 to 750 MB). route() refuses an over-limit Content-Length up front (413); this cap also stops a chunked
// body that announces none, as soon as it passes the limit.
function bodyLimitFor(pathname: string): number {
  if (/^\/data-studio\/profile\/.*\/import$/.test(pathname)) return config.maxImportBodyBytes
  return config.maxJsonBodyBytes
}

function readBody(req: IncomingMessage): Promise<string> {
  const limit = bodyLimitFor(new URL(req.url ?? '/', 'http://localhost').pathname)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// The caller's address, for rate limits. Behind `config.trustProxyHops` proxies it is the entry they added to
// X-Forwarded-For; with none trusted the header is ignored (a client can write anything there).
function clientIp(req: IncomingMessage): string | undefined {
  if (config.trustProxyHops <= 0) return undefined
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean)
  return forwarded[forwarded.length - config.trustProxyHops] ?? req.socket.remoteAddress
}

function rateLimited(res: ServerResponse): void {
  sendJson(res, 429, { error: 'too many attempts, try again shortly', code: 'rate_limited' })
}

// Per-user limit for one kind of costly call (AI suggestion, Run on Dremio, import, sync, reindex, upload).
async function costlyAllowed(kind: string, userId: number): Promise<boolean> {
  return checkRateLimit(`costly:${kind}`, String(userId), config.costlyRateLimitMax, 60_000)
}

// Every route below except /auth/register, /auth/login, /auth/logout,
// /models, and OPTIONS needs a real identity. Browsers can't set custom
// headers on a WS upgrade or a
// dynamically-`import()`-ed module (packages/agent-core (transport)/README.md's Phase 5
// note already established this for the WS case) — both fall back to a
// `?token=` query param, matching the one already-solved shape rather than
// inventing a second one. A normal `fetch()`-based route (manifest, plugin
// catalog, toggle, purge, admin listings) can and does use a real
// `Authorization: Bearer <token>` header (app/src/main.ts sends it).
async function identityFromRequest(req: IncomingMessage, url: URL): Promise<AuthedIdentity | undefined> {
  const authHeader = req.headers.authorization
  // Header only (2026-10-06): a `?token=` in the URL ends up in every proxy's access log. The WebSocket, which
  // cannot send a header, uses a single-use ticket instead (POST /auth/ws-ticket). `url` stays in the signature
  // for the ~40 callers.
  void url
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined
  if (!token) return undefined
  return resolveIdentity(token)
}

// A session with no `session_owners` row (created before Phase 7, or some
// future race) falls through to "admin only" — the safe default, not a
// special case (api/migrations/002_users_and_ownership.sql's own comment
// explains why this needs no separate migration/backfill step).
async function canAccessSession(identity: AuthedIdentity, sessionId: string): Promise<boolean> {
  if (identity.role === 'admin') return true
  const ownerId = await getSessionOwnerId(sessionId)
  return ownerId === identity.userId
}

// Same rule as canAccessSession, for a project (docs/rlm-transfer-plan.md 9.1).
async function canAccessProject(identity: AuthedIdentity, projectId: string): Promise<boolean> {
  if (!SESSION_ID_RE.test(projectId)) return false
  if (identity.role === 'admin') return true
  return (await getProjectOwnerId(projectId)) === identity.userId
}

// A project name from a JSON body `{ name }`: trimmed, 1..PROJECT_NAME_MAX characters.
async function readProjectName(req: IncomingMessage): Promise<string | undefined> {
  try {
    const body = JSON.parse(await readBody(req)) as { name?: unknown }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    return name.length > 0 && name.length <= PROJECT_NAME_MAX ? name : undefined
  } catch {
    return undefined
  }
}

function requireRole(identity: AuthedIdentity | undefined, role: Role): identity is AuthedIdentity {
  return !!identity && identity.role === role
}

function route(req: IncomingMessage, res: ServerResponse): void {
  // app is a separately-served static bundle (roadmap Phase 2 step 4),
  // so its origin differs from the gateway's in any real deployment — the
  // browser sends a CORS preflight before the real POST (application/json
  // isn't a CORS-safelisted content-type), and now also before a real
  // `Authorization` header (Phase 7 — also not a CORS-safelisted header).
  // 2026-10-06: only the origins in ALLOWED_ORIGINS (was `*`); none by default — the app is served from the same
  // origin as this API (its nginx / dev server proxies here), which needs no CORS at all.
  const origin = req.headers.origin
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'Origin')
  }
  // Real bug fixed 2026-09-10 (user: "có rõ ràng mà bị lỗi cors" —
  // PATCH /sessions/:id, HistoryChat.tsx's rename): `PATCH` was missing
  // from this list since the route itself was added (Phase 12 item 2) —
  // the browser's CORS preflight (a real cross-origin request here, gateway
  // and app on different ports) rejected the real PATCH before it
  // ever reached this server, with NO server-side trace at all (explains
  // why services/gateway's own log showed zero PATCH/rename_ok entries
  // despite normal WS activity from the same real account — a CORS
  // rejection happens entirely in the browser, the request never leaves
  // it). `DELETE` already being here (added for the real
  // `DELETE /sessions/:id` route, docs/code-rules.md §74) is what made
  // this specific gap easy to miss — it looked complete.
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type, authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')

  // A JSON body over the limit is refused before a byte of it is read (uploads stream to disk with their own limit).
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > bodyLimitFor(url.pathname) && !WORKSPACE_FILES_PATH.test(url.pathname)) {
    res.setHeader('connection', 'close')
    sendJson(res, 413, { error: 'request body too large', code: 'body_too_large' })
    req.destroy()
    return
  }

  // Probes (no auth, no CORS): liveness = this process answers; readiness = it AND every agent runtime can take a chat.
  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
    const health = runtime.health()
    const ok = url.pathname === '/healthz' || health.ready
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
    // shard up/down only — ports and restart counts are internal (2026-10-06)
    const shards = health.shards.map((shard) => ({ index: shard.index, up: shard.up }))
    res.end(JSON.stringify({ ok, ...(url.pathname === '/readyz' ? { ready: health.ready, shards } : {}) }))
    return
  }


  // i18n (2026-09-10): `/auth/register`+`/auth/login` are the only 2 routes
  // whose `error` string is actually shown to a user today (app's
  // ConnectForm) — every error response from THESE 2 routes now also sends
  // a stable `code` alongside the existing `error` string, so app can
  // show it in whichever language is selected instead of always English.
  // Purely additive: `error` is unchanged (still the real fallback FE uses
  // for a `code` it doesn't recognize), no status code or behavior change.
  // Every other route below (session management, plugin inventory,
  // admin...) is deliberately NOT touched — none of their errors are
  // surfaced to a user anywhere yet (console-only), so a `code` there would
  // be speculative, not a real need.
  // Admin creates an account (adminGate): POST /users (or the old /auth/register path), body {email, password, role?}.
  if (req.method === 'POST' && (url.pathname === '/auth/register' || url.pathname === '/users')) {
    handle(res, async () => {
      // Security fix 2026-09-09: no rate-limit existed here at all before —
      // checked first, before even reading the body, so a hammered client
      // doesn't cost more than 1 Redis round trip per attempt.
      // Admin-only route (adminGate): counted per admin account (2026-10-06; was per socket address — the proxy's).
      const creator = await identityFromRequest(req, url)
      if (!(await checkRateLimit('register', String(creator?.userId ?? 'anonymous'), config.authRateLimitMax, config.authRateLimitWindowMs))) {
        return rateLimited(res)
      }
      let body: { email?: unknown; password?: unknown; role?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON body', code: 'invalid_json' }))
        return
      }
      // email <= 255: discovery_users.email is varchar(255); a longer one must be a 400, not a database error.
      if (typeof body.email !== 'string' || body.email.length > 255 || typeof body.password !== 'string' || body.password.length < 8) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ error: 'an email (at most 255 characters) and a password of at least 8 characters are required', code: 'invalid_registration_input' }),
        )
        return
      }
      try {
        if (body.role !== undefined && body.role !== 'admin' && body.role !== 'user') {
          return sendJson(res, 400, { error: "role must be 'admin' or 'user'", code: 'invalid_role' })
        }
        const user = await register(body.email, body.password, (body.role as Role | undefined) ?? 'user')
        log('register_ok', { userId: user.id })
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify(user))
      } catch (error) {
        log('register_failed', { error: String(error) })
        // Security fix 2026-09-09: only the one real, safe, expected error
        // (email already taken) gets its message forwarded to the client —
        // anything else (DB down, driver internals, ...) used to leak
        // `String(error)` raw to an UNauthenticated request. Full detail
        // still goes to the server log above either way.
        if (error instanceof Error && error.message === 'email already registered') {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'email already registered', code: 'email_taken' }))
          return
        }
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'registration failed', code: 'registration_failed' }))
      }
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/auth/login') {
    handle(res, async () => {
      // Security fix 2026-09-09: separate bucket from /auth/register (same
      // reasoning as that route's own comment) — a login brute-force
      // attempt shouldn't also lock a real user out of registering.
      // 2026-10-06: per IP only behind a trusted proxy (else every caller shares the proxy's address — measured:
      // 10 bad logins locked out every user), and per email always: guessing one account's password locks that
      // account for the window, nobody else.
      const ip = clientIp(req)
      if (ip && !(await checkRateLimit('login-ip', ip, config.authIpRateLimitMax, config.authRateLimitWindowMs))) {
        return rateLimited(res)
      }
      let body: { email?: unknown; password?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON body', code: 'invalid_json' }))
        return
      }
      const emailKey = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 255) : ''
      if (!(await checkRateLimit('login', emailKey, config.authRateLimitMax, config.authRateLimitWindowMs))) {
        return rateLimited(res)
      }
      const result =
        typeof body.email === 'string' && typeof body.password === 'string' ? await login(body.email, body.password) : undefined
      if (!result) {
        log('login_failed', { email: typeof body.email === 'string' ? body.email : undefined })
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid email or password', code: 'invalid_credentials' }))
        return
      }
      log('login_ok', { userId: result.userId })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token: result.token, email: result.email, role: result.role }))
    })
    return
  }

  // Phase 12: real gap found while checking the FE's login/logout flow —
  // `src/auth.ts`'s `logout()` (revokes the token in Redis, Phase 7) had
  // ZERO callers anywhere in this codebase. The FE's old "Disconnect"
  // button only ever closed the WebSocket and re-showed the login form —
  // the token stayed valid (and stayed in sessionStorage) the whole time,
  // so a reload while the tab was still open would silently reconnect with
  // the "logged out" session. This route + app's rewired logout button
  // (main.ts) close that gap for real.
  // A single-use, 30-second ticket to open one chat WebSocket (the browser cannot send the Authorization header on
  // the upgrade; the token itself must not go in the URL). See redis.ts storeWsTicket.
  if (req.method === 'POST' && url.pathname === '/auth/ws-ticket') {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      const authHeader = req.headers.authorization ?? ''
      if (!identity || !authHeader.startsWith('Bearer ')) return sendJson(res, 401, { error: 'unauthorized' })
      return sendJson(res, 200, { ticket: await issueWsTicket(authHeader.slice('Bearer '.length)) })
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    handle(res, async () => {
      // Idempotent by design (same spirit as register/login's own error
      // handling) — logging out an already-invalid/expired token is not an
      // error, the end state (no valid token) is identical either way, so
      // this doesn't need a full `identityFromRequest` resolution first.
      const authHeader = req.headers.authorization
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined
      const token = bearerToken ?? url.searchParams.get('token') ?? undefined
      if (token) await logout(token)
      log('logout_ok', {})
      res.writeHead(204)
      res.end()
    })
    return
  }

  // Follow-up (2026-09-08): the boot manifest + per-plugin client.js proxy
  // routes that used to live here (Phase 4-12) are REMOVED along with the
  // whole per-session dynamically-composed UI plugin mechanism — see
  // app/README.md. `app` is now one single, normally-built React
  // app served as a static bundle, same for every user.
  //
  // Session-scoped (ownership-or-admin), proxied to whichever worker
  // `ensureSession` says is live for it — the one piece of that whole
  // mechanism still worth keeping (a genuinely useful diagnostic, unrelated
  // to how the FE is delivered).
  const pluginInventoryMatch = PLUGIN_INVENTORY_PATH.exec(url.pathname)
  if (req.method === 'GET' && pluginInventoryMatch) {
    handle(res, async () => {
      const sessionId = pluginInventoryMatch[1]
      if (!SESSION_ID_RE.test(sessionId)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid session id' }))
        return
      }
      const identity = await identityFromRequest(req, url)
      if (!identity) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      // The runtime's plugin tree is shared by every session it serves, so this is operator-only now.
      if (identity.role !== 'admin') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      try {
        const upstream = await runtime.pluginInventory(sessionId)
        res.writeHead(upstream.status, { 'content-type': 'application/json' })
        res.end(upstream.body)
      } catch (error) {
        console.error(`[gateway] plugin-inventory(${sessionId}) failed:`, error)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'failed to fetch plugin inventory' }))
      }
    })
    return
  }

  // Phase 5/6/7's services/plugin-registry proxy (catalog browse/submit/
  // approve, per-session enable/disable) — REMOVED for real, Phase 16
  // (docs/agent-core-architecture-roadmap.md): the real need turned out to
  // be "every user gets the same fixed capability set", not "each user/
  // session picks their own" — the only thing that whole mechanism ever
  // existed to support. Adding a new capability now works exactly like
  // `packages/tool/serper-web-search`: write a real package,
  // `insert:` it into the plugin tree, redeploy — always present for every
  // session, no catalog/approval/toggle involved.

  // Phase 7 admin-only listings — gateway's own bookkeeping (session_owners),
  // never proxied anywhere (the runtime has no "list every session" route and
  // does not know about users, and a
  // full session list is exactly that kind of thing gateway shouldn't push
  // down into it just for this).
  // Admin: change a user's role and/or reset the password (adminGate). Revokes that user's logins.
  const userMatch = req.method === 'PATCH' ? /^\/users\/(\d+)$/.exec(url.pathname) : null
  if (userMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      let body: { role?: unknown; password?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body', code: 'invalid_json' })
      }
      if (body.role !== undefined && body.role !== 'admin' && body.role !== 'user') return sendJson(res, 400, { error: "role must be 'admin' or 'user'", code: 'invalid_role' })
      if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length < 8)) return sendJson(res, 400, { error: 'password must be at least 8 characters', code: 'invalid_password' })
      if (body.role === undefined && body.password === undefined) return sendJson(res, 400, { error: 'nothing to change' })
      const userId = Number(userMatch[1])
      // An admin cannot demote themselves: it would lock the last admin out by accident.
      if (identity?.userId === userId && body.role === 'user') return sendJson(res, 400, { error: 'you cannot remove your own admin role', code: 'self_demote' })
      const changed = await changeUser(userId, { ...(body.role !== undefined ? { role: body.role as Role } : {}), ...(typeof body.password === 'string' ? { password: body.password } : {}) })
      if (!changed) return sendJson(res, 404, { error: 'user not found' })
      log('user_changed', { userId, by: identity?.userId, role: body.role, passwordReset: body.password !== undefined })
      res.writeHead(204)
      res.end()
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/users') {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!requireRole(identity, 'admin')) {
        res.writeHead(identity ? 403 : 401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: identity ? 'admin role required' : 'unauthorized' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(await listUsers()))
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/sessions') {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!requireRole(identity, 'admin')) {
        res.writeHead(identity ? 403 : 401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: identity ? 'admin role required' : 'unauthorized' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(await listSessionOwners()))
    })
    return
  }

  // Phase 12 item 2: the route that didn't exist AT ALL before this phase —
  // any authenticated user (not just admin, unlike GET /sessions above) can
  // list their OWN sessions. Status is joined in live from this process's own
  // connection table (runtime/live.ts; the database never duplicates it) — a
  // session nobody is connected to reads as 'hibernated', "not currently running".
  if (req.method === 'GET' && SESSION_MINE_PATH.test(url.pathname)) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const rows = await listSessionsForOwner(identity.userId)
      // 'running' = a browser is connected to it right now; every other session is just a log on disk.
      const withStatus = rows.map((row) => ({ ...row, status: isLive(row.sessionId) ? 'running' : 'hibernated' }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(withStatus))
    })
    return
  }

  // Phase 12 item 4: static config, no identity/ownership check at all —
  // unlike every other route here, this one must be readable BEFORE login
  // (app's connect-form populates the model picker on page load, before
  // any token exists — see app/src/main.ts). Same "not dangerous on its
  // own" reasoning already applied to plugin-catalog browsing, just without
  // even the identity requirement that has, since there's no earlier point
  // in the flow to get one from.
  if (req.method === 'GET' && MODELS_PATH.test(url.pathname)) {
    handle(res, async () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: config.allowedModels }))
    })
    return
  }

  // Phase 12 item 2: rename — the sidebar session-list's one write action
  // besides switch/create. Ownership-or-admin, same check as purge below.
  const renameMatch = req.method === 'PATCH' ? SESSION_RENAME_PATH.exec(url.pathname) : null
  if (renameMatch) {
    handle(res, async () => {
      const sessionId = renameMatch[1]
      if (!SESSION_ID_RE.test(sessionId)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid session id' }))
        return
      }
      const identity = await identityFromRequest(req, url)
      if (!identity) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (!(await canAccessSession(identity, sessionId))) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      let body: { title?: unknown; source?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON body' }))
        return
      }
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'title is required' }))
        return
      }
      const title = body.title.trim()
      // Real bug fixed 2026-09-10 (user: "nhớ có check lỗi ko quá 255 kí
      // tự", HistoryChat.tsx's rename input): used to silently
      // `.slice(0, 200)` an over-length title instead of rejecting it — an
      // arbitrary number that didn't even match `sessions.title`'s real
      // `varchar(255)` column width (docs/code-rules.md's DB id/title
      // migration entry). A real 400 at the real column limit now, matching
      // the FE's own client-side check instead of a silent truncation the
      // user never asked for and wouldn't see happen.
      if (title.length > 255) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'title must be at most 255 characters' }))
        return
      }
      // `source` is set only by the sidebar's automatic titles (db.ts renameSession).
      const source: TitleSource = body.source === 'fallback' || body.source === 'provider' ? body.source : 'user'
      await renameSession(sessionId, title, source)
      log('rename_ok', { sessionId, userId: identity.userId, source })
      res.writeHead(204)
      res.end()
    })
    return
  }

  // Phase 6 checklist item 4: real delete-on-request — proxied straight to
  // runtime/sessions.ts's purgeSessionData, plus
  // (Phase 7) gateway's own ownership-row cleanup so a purged-then-reused
  // session id never inherits stale ownership.
  const purgeMatch = SESSION_PURGE_PATH.exec(url.pathname)
  if (req.method === 'DELETE' && purgeMatch) {
    handle(res, async () => {
      const sessionId = purgeMatch[1]
      if (!SESSION_ID_RE.test(sessionId)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid session id' }))
        return
      }
      const identity = await identityFromRequest(req, url)
      if (!identity) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (!(await canAccessSession(identity, sessionId))) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      try {
        const info = await getSessionRuntimeInfo(sessionId)
        if (info) await purgeSessionData(runtime, sessionId, info)
        await deleteSessionRow(sessionId)
        log('purge_ok', { sessionId, userId: identity.userId })
        res.writeHead(204)
        res.end()
      } catch (error) {
        log('purge_failed', { sessionId, error: String(error) })
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'failed to purge session' }))
      }
    })
    return
  }

  // Per-user skills (docs/skill-transfer-plan.md). `GET /skills` feeds the "/"
  // menu: built-in skills a user may invoke directly + the user's own.
  if (req.method === 'GET' && url.pathname === '/skills') {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const custom = await listCustomSkills(identity.userId)
      sendJson(res, 200, {
        skills: [
          ...builtinSkills
            .filter((skill) => skill.userInvocable)
            .map((skill) => ({ name: skill.name, description: skill.description, source: 'builtin' })),
          ...custom.map((skill) => ({ name: skill.name, description: skill.description, source: 'custom' })),
        ],
      })
    })
    return
  }

  // Projects (docs/rlm-transfer-plan.md 9.1): GET/POST /projects,
  // PATCH/DELETE /projects/:id, GET /projects/:id/sessions. Owner (or admin) only.
  if (PROJECTS_PATH.test(url.pathname) && (req.method === 'GET' || req.method === 'POST')) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      if (req.method === 'GET') return sendJson(res, 200, { projects: await listProjectsForOwner(identity.userId) })
      const name = await readProjectName(req)
      if (name === undefined) return sendJson(res, 400, { error: `name is required, at most ${PROJECT_NAME_MAX} characters` })
      const project = await createProject(identity.userId, name)
      log('project_created', { projectId: project.projectId, userId: identity.userId })
      sendJson(res, 201, project)
    })
    return
  }

  const projectMatch = PROJECT_PATH.exec(url.pathname)
  const projectSessionsMatch = PROJECT_SESSIONS_PATH.exec(url.pathname)
  if ((projectMatch && (req.method === 'PATCH' || req.method === 'DELETE')) || (projectSessionsMatch && req.method === 'GET')) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const projectId = (projectMatch ?? projectSessionsMatch)![1]
      if (!(await canAccessProject(identity, projectId))) return sendJson(res, 404, { error: 'project not found' })
      if (projectSessionsMatch) return sendJson(res, 200, { sessions: await listSessionsForProject(projectId) })
      if (req.method === 'PATCH') {
        const name = await readProjectName(req)
        if (name === undefined) return sendJson(res, 400, { error: `name is required, at most ${PROJECT_NAME_MAX} characters` })
        await renameProject(projectId, name)
        res.writeHead(204)
        res.end()
        return
      }
      // Deleting a project deletes its chats and its shared folder.
      try {
        for (const sessionId of await listSessionIdsForProject(projectId)) {
          const info = await getSessionRuntimeInfo(sessionId)
          if (info) await purgeSessionData(runtime, sessionId, info)
          await deleteSessionRow(sessionId)
        }
        await deleteProjectData(projectId)
        await deleteProjectRow(projectId)
        log('project_deleted', { projectId, userId: identity.userId })
        res.writeHead(204)
        res.end()
      } catch (error) {
        log('project_delete_failed', { projectId, error: String(error) })
        sendJson(res, 502, { error: 'failed to delete project' })
      }
    })
    return
  }

  // "Đưa vào dự án": POST /projects/:id/promote { sessionId, path } copies that
  // chat's output into the project's shared outputs/. The chat must belong to the project.
  const promoteMatch = PROJECT_PROMOTE_PATH.exec(url.pathname)
  if (req.method === 'POST' && promoteMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const projectId = promoteMatch[1]
      if (!(await canAccessProject(identity, projectId))) return sendJson(res, 404, { error: 'project not found' })
      let body: { sessionId?: unknown; path?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' })
      }
      const { sessionId, path } = body
      if (typeof sessionId !== 'string' || typeof path !== 'string' || !(await listSessionIdsForProject(projectId)).includes(sessionId)) {
        return sendJson(res, 404, { error: 'output not found' })
      }
      try {
        const dir = projectDirFor(projectId)
        const promoted = dir ? await promoteOutput(dir, sessionId, path) : undefined
        if (!promoted) return sendJson(res, 404, { error: 'output not found' })
        log('project_promote_ok', { projectId, sessionId })
        sendJson(res, 201, { path: promoted })
      } catch (error) {
        log('project_promote_failed', { projectId, error: String(error) })
        sendJson(res, 500, { error: 'promote failed' })
      }
    })
    return
  }

  // docs/data-studio-admin-ui-plan.md — semantic-layer admin CRUD (Data
  // Sources section). Any authenticated user, same as the chat itself
  // (`analyze_data`) — no per-row ownership concept for this data, unlike
  // sessions/projects/skills.
  if (req.method === 'GET' && url.pathname === '/data-studio/sources') {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      sendJson(res, 200, await listDataSources())
    })
    return
  }

  const sourceMatch = req.method === 'GET' || req.method === 'PATCH' || req.method === 'DELETE' ? DATA_STUDIO_SOURCE_PATH.exec(url.pathname) : null
  if (sourceMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const sourceId = sourceMatch[1]
      if (req.method === 'GET') {
        const source = await getDataSource(sourceId)
        return source ? sendJson(res, 200, source) : sendJson(res, 404, { error: 'data source not found' })
      }
      if (req.method === 'DELETE') {
        // Soft delete (reference data_source_deletion.py): its tables and columns are deprecated and leave the
        // search index; a later import of the same source restores it.
        const reply = await callAdmin({ op: 'delete_source', source_id: sourceId })
        log('data_studio_source_deleted', { sourceId, userId: identity.userId, ok: reply.ok })
        if (!reply.ok) return sendJson(res, reply.status ?? 502, { error: reply.error })
        res.writeHead(204)
        return res.end()
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' })
      }
      const updated = await updateDataSource(sourceId, body)
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'data source not found' })
    })
    return
  }

  const sourceEntitiesMatch = req.method === 'GET' ? DATA_STUDIO_SOURCE_ENTITIES_PATH.exec(url.pathname) : null
  if (sourceEntitiesMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      sendJson(res, 200, await listEntitiesForSource(sourceEntitiesMatch[1]))
    })
    return
  }

  const entityColumnsMatch = req.method === 'GET' ? DATA_STUDIO_ENTITY_COLUMNS_PATH.exec(url.pathname) : null
  if (entityColumnsMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      sendJson(res, 200, await listColumnsForEntity(entityColumnsMatch[1]))
    })
    return
  }

  const entityMatch = req.method === 'GET' || req.method === 'PATCH' ? DATA_STUDIO_ENTITY_PATH.exec(url.pathname) : null
  if (entityMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const entityId = entityMatch[1]
      if (req.method === 'GET') {
        const entity = await getEntity(entityId)
        return entity ? sendJson(res, 200, entity) : sendJson(res, 404, { error: 'entity not found' })
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' })
      }
      const updated = await updateEntity(entityId, body)
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'entity not found' })
    })
    return
  }

  const columnMatch = req.method === 'GET' || req.method === 'PATCH' ? DATA_STUDIO_COLUMN_PATH.exec(url.pathname) : null
  if (columnMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const columnId = columnMatch[1]
      if (req.method === 'GET') {
        const column = await getEntityColumn(columnId)
        return column ? sendJson(res, 200, column) : sendJson(res, 404, { error: 'column not found' })
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' })
      }
      const updated = await updateEntityColumn(columnId, body)
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'column not found' })
    })
    return
  }

  if (DATA_STUDIO_GLOSSARY_PATH.test(url.pathname) && (req.method === 'GET' || req.method === 'POST')) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      if (req.method === 'GET') return sendJson(res, 200, await listGlossaryTerms())
      let body: { term?: unknown; definition_text?: unknown; synonyms?: unknown; sql_expressions?: unknown; related_entity_ids?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' })
      }
      if (typeof body.term !== 'string' || !body.term.trim() || typeof body.definition_text !== 'string' || !body.definition_text.trim()) {
        return sendJson(res, 400, { error: 'term and definition_text are required' })
      }
      const created = await createGlossaryTerm({
        term: body.term,
        definition_text: body.definition_text,
        synonyms: Array.isArray(body.synonyms) ? body.synonyms : undefined,
        sql_expressions: Array.isArray(body.sql_expressions) ? body.sql_expressions : undefined,
        related_entity_ids: Array.isArray(body.related_entity_ids) ? body.related_entity_ids : undefined,
      })
      sendJson(res, 201, created)
    })
    return
  }

  const glossaryTermMatch =
    req.method === 'PATCH' || req.method === 'DELETE' ? DATA_STUDIO_GLOSSARY_TERM_PATH.exec(url.pathname) : null
  if (glossaryTermMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const termId = glossaryTermMatch[1]
      if (req.method === 'DELETE') {
        if (!await deleteGlossaryTerm(termId)) return sendJson(res, 404, { error: 'term not found' })
        res.writeHead(204)
        return res.end()
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' })
      }
      const updated = await updateGlossaryTerm(termId, body)
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'term not found' })
    })
    return
  }

  if (req.method === 'GET' && DATA_STUDIO_BROWSE_ENTITIES_PATH.test(url.pathname)) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      sendJson(res, 200, await listBrowseEntities())
    })
    return
  }

  if (DATA_STUDIO_RELATIONSHIPS_PATH.test(url.pathname) && (req.method === 'GET' || req.method === 'POST')) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      if (req.method === 'GET') return sendJson(res, 200, await listRelationships())
      const input = await parseRelationshipInput(req, res)
      if (!input) return
      sendJson(res, 201, await createRelationship(input))
    })
    return
  }

  const relationshipMatch =
    req.method === 'PATCH' || req.method === 'DELETE' ? DATA_STUDIO_RELATIONSHIP_PATH.exec(url.pathname) : null
  if (relationshipMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const relationshipId = relationshipMatch[1]
      if (req.method === 'DELETE') {
        if (!await deleteRelationship(relationshipId)) return sendJson(res, 404, { error: 'relationship not found' })
        res.writeHead(204)
        return res.end()
      }
      const input = await parseRelationshipInput(req, res)
      if (!input) return
      const updated = await updateRelationship(relationshipId, input)
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'relationship not found' })
    })
    return
  }

  if (DATA_STUDIO_METRICS_PATH.test(url.pathname) && (req.method === 'GET' || req.method === 'POST')) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      if (req.method === 'GET') return sendJson(res, 200, await listMetrics())
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' })
      }
      const { name, base_entity_id, aggregation, measure_column_id } = body
      if (
        typeof name !== 'string' || !name.trim() ||
        typeof base_entity_id !== 'string' ||
        typeof aggregation !== 'string' ||
        typeof measure_column_id !== 'string'
      ) {
        return sendJson(res, 400, { error: 'name, base_entity_id, aggregation, and measure_column_id are required' })
      }
      sendJson(res, 201, await createMetric(body as unknown as MetricInput))
    })
    return
  }

  const metricMatch = req.method === 'PATCH' || req.method === 'DELETE' ? DATA_STUDIO_METRIC_PATH.exec(url.pathname) : null
  if (metricMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const metricId = metricMatch[1]
      if (req.method === 'DELETE') {
        if (!await deleteMetric(metricId)) return sendJson(res, 404, { error: 'metric not found' })
        res.writeHead(204)
        return res.end()
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' })
      }
      const updated = await updateMetric(metricId, body)
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'metric not found' })
    })
    return
  }

  // docs/data-studio-admin-ui-plan.md — the 2 admin actions that need real
  // Dremio calls (Python, packages/tool/data-studio-agent/python/bridge/admin_runner.py),
  // unlike every other /data-studio/* route above (plain sqlite CRUD here).
  if (req.method === 'POST' && DATA_STUDIO_DREMIO_BROWSE_PATH.test(url.pathname)) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      try {
        const reply = await runAdminBridge({ op: 'browse' })
        return reply.ok ? sendJson(res, 200, { sources: reply.sources }) : sendJson(res, 502, { error: reply.error })
      } catch (error) {
        log('data_studio_dremio_browse_failed', { error: String(error) })
        return sendJson(res, 502, { error: 'failed to reach the Dremio bridge' })
      }
    })
    return
  }

  if (req.method === 'POST' && DATA_STUDIO_DREMIO_SYNC_PATH.test(url.pathname)) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      if (!(await costlyAllowed('sync', identity.userId))) return rateLimited(res)
      let body: { source_names?: unknown; datasets?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' })
      }
      const sourceNames = Array.isArray(body.source_names) ? body.source_names : null
      // datasets: full Dremio paths picked one by one (GET .../datasets); when given, only these are imported
      const datasets = Array.isArray(body.datasets)
        ? body.datasets.filter((p): p is string[] => Array.isArray(p) && p.length > 0 && p.every((x) => typeof x === 'string'))
        : null
      try {
        // Sync walks Dremio's real catalog tree, so it legitimately takes
        // longer than the browse call above — same generous ceiling
        // packages/tool/data-studio-agent gives the chat-side pipeline.
        const reply = await runAdminBridge({ op: 'sync', source_names: sourceNames, datasets }, 240_000)
        return reply.ok
          ? sendJson(res, 200, { summary: reply.summary, reindexSummary: reply.reindex_summary })
          : sendJson(res, 502, { error: reply.error })
      } catch (error) {
        log('data_studio_dremio_sync_failed', { error: String(error) })
        return sendJson(res, 502, { error: 'failed to reach the Dremio bridge' })
      }
    })
    return
  }

  const datasetsMatch = req.method === 'GET' ? DATA_STUDIO_DREMIO_DATASETS_PATH.exec(url.pathname) : null
  if (datasetsMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const reply = await callAdmin({ op: 'datasets', source_name: decodeURIComponent(datasetsMatch[1]) }, 120_000)
      return reply.ok ? sendJson(res, 200, { datasets: reply.datasets }) : sendJson(res, reply.status ?? 502, { error: reply.error })
    })
    return
  }

  // SQL console (admin only, like every /data-studio/* write): read-only SQL on Dremio, every run audited.
  // It bypasses the per-table allow-user rules by design, which is why only admins reach it (needsAdmin).
  const profileMatch = url.pathname.match(DATA_STUDIO_PROFILE_PATH)
  if (profileMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(req.method ?? '')) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      let body: unknown
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req)
        if (raw.length > 20_000_000) return sendJson(res, 413, { error: 'body too large' })
        try {
          body = raw ? JSON.parse(raw) : undefined
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' })
        }
      }
      const query: Record<string, string> = {}
      for (const [key, value] of url.searchParams) if (key !== 'token') query[key] = value
      const path = profileMatch[1]
      // Reindex, import (reindexes what it changed), AI suggestions and Run can take minutes: those get a process
      // of their own, so they never queue the quick reads and saves behind them on the shared worker.
      const slow = /\/(reindex|import|suggest-[a-z]+|run)$/.test(path)
      if (slow) {
        const kind = path.slice(path.lastIndexOf('/') + 1).replace(/^suggest-.*/, 'suggest')
        if (!(await costlyAllowed(kind, identity.userId))) return rateLimited(res)
      }
      const user = await getUserById(identity.userId)
      type ProfileReply = {
        ok: boolean; status?: number; error?: string; json?: unknown
        body_b64?: string; content_type?: string; content_disposition?: string | null
      }
      const request = { op: 'data_profile', method: req.method, path, query, body, user: user?.email ?? `user-${identity.userId}` }
      const reply: ProfileReply = await (slow ? runAdminBridge(request, 600_000) : callAdmin(request, 60_000)).catch((error: unknown): ProfileReply => ({ ok: false, status: 502, error: String(error) }))
      if (!reply.ok) return sendJson(res, reply.status ?? 502, { error: reply.error })
      if (req.method !== 'GET') log('data_profile_write', { userId: identity.userId, method: req.method, path, status: reply.status })
      if (reply.body_b64 !== undefined) {
        const headers: Record<string, string> = { 'content-type': reply.content_type || 'application/octet-stream' }
        if (reply.content_disposition) headers['content-disposition'] = reply.content_disposition
        res.writeHead(reply.status ?? 200, headers)
        return res.end(Buffer.from(reply.body_b64, 'base64'))
      }
      if (reply.status === 204) {
        res.writeHead(204)
        return res.end()
      }
      return sendJson(res, reply.status ?? 200, reply.json ?? null)
    })
    return
  }

  // Charts + dashboards — clone of the reference UI's flows (edit fields / colors, add to dashboard, dashboard
  // list / report / builder). Native JSON shapes, same contracts as bot-data-studio-api's dashboard routes.
  const readJson = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      const parsed = JSON.parse(await readBody(req))
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  const asStringArray = (value: unknown): string[] | null | undefined =>
    value === null ? null : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined
  const asStringMap = (value: unknown): Record<string, string> | null | undefined =>
    value === null
      ? null
      : value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'))
        : undefined

  if (req.method === 'GET' && DATA_STUDIO_AVAILABLE_CHARTS_PATH.test(url.pathname)) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      sendJson(res, 200, await availableCharts(identity.userId))
    })
    return
  }

  const chartMatch = req.method === 'PATCH' ? DATA_STUDIO_CHART_PATH.exec(url.pathname) : null
  if (chartMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const body = await readJson()
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' })
      const patch: Parameters<typeof updateChart>[2] = {}
      if ('title_override' in body) patch.title_override = typeof body.title_override === 'string' ? body.title_override : null
      if ('x_override' in body) patch.x_override = typeof body.x_override === 'string' ? body.x_override : null
      if ('y_override' in body) patch.y_override = asStringArray(body.y_override) ?? null
      if ('color_overrides' in body) patch.color_overrides = asStringMap(body.color_overrides) ?? {}
      if ('label_overrides' in body) patch.label_overrides = asStringMap(body.label_overrides) ?? {}
      const updated = await updateChart(chartMatch[1], identity.userId, patch)
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'chart not found' })
    })
    return
  }

  if (DATA_STUDIO_DASHBOARDS_PATH.test(url.pathname) && (req.method === 'GET' || req.method === 'POST')) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      if (req.method === 'GET') return sendJson(res, 200, await listDashboards(identity.userId))
      const body = await readJson()
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' })
      sendJson(
        res,
        201,
        await createDashboard(identity.userId, typeof body.title === 'string' ? body.title : undefined, typeof body.description === 'string' ? body.description : undefined),
      )
    })
    return
  }

  const dashboardMatch = req.method === 'GET' || req.method === 'PATCH' || req.method === 'DELETE' ? DATA_STUDIO_DASHBOARD_PATH.exec(url.pathname) : null
  if (dashboardMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const dashboardId = dashboardMatch[1]
      if (req.method === 'DELETE') {
        if (!(await deleteDashboard(dashboardId, identity.userId))) return sendJson(res, 404, { error: 'dashboard not found' })
        return sendJson(res, 200, { deleted: true })
      }
      if (req.method === 'GET') {
        const dashboard = await getDashboard(dashboardId, identity.userId)
        return dashboard ? sendJson(res, 200, dashboard) : sendJson(res, 404, { error: 'dashboard not found' })
      }
      const body = await readJson()
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' })
      const updated = await updateDashboard(dashboardId, identity.userId, {
        title: typeof body.title === 'string' ? body.title : null,
        description: typeof body.description === 'string' ? body.description : null,
        appearance: body.appearance && typeof body.appearance === 'object' && !Array.isArray(body.appearance) ? (body.appearance as Record<string, unknown>) : null,
      })
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'dashboard not found' })
    })
    return
  }

  // "Thêm vào dashboard" from a chat chart.
  const pinMatch = req.method === 'POST' ? DATA_STUDIO_DASHBOARD_CHARTS_PATH.exec(url.pathname) : null
  if (pinMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const body = await readJson()
      if (!body || typeof body.chart_id !== 'string') return sendJson(res, 400, { error: 'chart_id is required' })
      const result = await pinChart(pinMatch[1], body.chart_id, identity.userId)
      if (result === 'no-dashboard') return sendJson(res, 404, { error: 'dashboard not found' })
      if (result === 'no-chart') return sendJson(res, 404, { error: 'chart not found' })
      sendJson(res, 200, result)
    })
    return
  }

  const widgetsMatch = req.method === 'POST' || req.method === 'PUT' ? DATA_STUDIO_DASHBOARD_WIDGETS_PATH.exec(url.pathname) : null
  if (widgetsMatch) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const dashboardId = widgetsMatch[1]
      const body = await readJson()
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' })
      if (req.method === 'PUT') {
        // Builder "Xuất bản": bulk-save the layout (update kept, create new, delete missing).
        const list = Array.isArray(body.widgets) ? body.widgets : []
        const widgets = list
          .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
          .map((w) => ({
            id: typeof w.id === 'string' ? w.id : null,
            kind: typeof w.kind === 'string' ? w.kind : 'chart',
            chart_id: typeof w.chart_id === 'string' ? w.chart_id : null,
            x: Number.isFinite(w.x) ? Number(w.x) : 0,
            y: Number.isFinite(w.y) ? Number(w.y) : 0,
            w: Number.isFinite(w.w) ? Number(w.w) : 6,
            h: Number.isFinite(w.h) ? Number(w.h) : 4,
            title_override: typeof w.title_override === 'string' ? w.title_override : null,
            note: typeof w.note === 'string' ? w.note : null,
            text: typeof w.text === 'string' ? w.text : null,
          }))
        const saved = await saveWidgets(dashboardId, identity.userId, widgets)
        if (saved === 'no-dashboard') return sendJson(res, 404, { error: 'dashboard not found' })
        if (saved === 'no-chart') return sendJson(res, 404, { error: 'chart not found' })
        return sendJson(res, 200, saved)
      }
      const added = await addWidget(dashboardId, identity.userId, {
        kind: typeof body.kind === 'string' ? body.kind : undefined,
        chart_id: typeof body.chart_id === 'string' ? body.chart_id : null,
        text: typeof body.text === 'string' ? body.text : null,
        title: typeof body.title === 'string' ? body.title : null,
      })
      if (added === 'no-dashboard') return sendJson(res, 404, { error: 'dashboard not found' })
      if (added === 'no-chart') return sendJson(res, 404, { error: 'chart not found' })
      sendJson(res, 200, added)
    })
    return
  }

  // GET /sessions/:id/files lists, POST /sessions/:id/files?name=<file> uploads
  // the raw body, GET /sessions/:id/files/<path> downloads — the same under
  // /projects/:id/files for a project's shared folder. Owner (or admin) only;
  // a chat without a working directory answers 404.
  const workspaceMatch = WORKSPACE_FILES_PATH.exec(url.pathname)
  if (workspaceMatch && (req.method === 'GET' || (req.method === 'POST' && !workspaceMatch[3]))) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const [, kind, id, path] = workspaceMatch
      const allowed =
        kind === 'projects' ? await canAccessProject(identity, id) : SESSION_ID_RE.test(id) && (await canAccessSession(identity, id))
      if (!allowed) return sendJson(res, 404, { error: 'not found' })
      const owner = `${kind}/${id}`
      let dir: string | undefined
      if (kind === 'projects') dir = projectDirFor(id)
      else {
        const info = await getSessionRuntimeInfo(id)
        dir = info ? workspaceDirForSession(info, id) : undefined
      }
      if (!dir) return sendJson(res, 404, { error: 'no working directory' })

      try {
        if (req.method === 'POST') {
          if (!(await costlyAllowed('upload', identity.userId))) return rateLimited(res)
          const name = url.searchParams.get('name') ?? ''
          if (!UPLOAD_NAME_RE.test(name)) return sendJson(res, 400, { error: 'invalid file name' })
          try {
            await saveUpload(dir, name, req)
          } catch (error) {
            if (error instanceof UploadTooLargeError) return sendJson(res, 413, { error: error.message })
            throw error
          }
          log('workspace_upload', { owner, userId: identity.userId })
          return sendJson(res, 201, { path: name })
        }
        if (!path) return sendJson(res, 200, { files: await listWorkspaceFiles(dir) })
        const target = resolveInside(dir, decodeURIComponent(path))
        const info = target ? await stat(target).catch(() => undefined) : undefined
        if (!target || !info?.isFile()) return sendJson(res, 404, { error: 'file not found' })
        res.writeHead(200, { 'content-type': contentTypeFor(target), 'content-length': info.size })
        createReadStream(target).pipe(res)
      } catch (error) {
        log('workspace_files_failed', { owner, error: String(error) })
        if (!res.headersSent) sendJson(res, 500, { error: 'files unavailable' })
        else res.end()
      }
    })
    return
  }

  if (url.pathname === '/custom-skills' && (req.method === 'GET' || req.method === 'POST')) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      if (req.method === 'GET') return sendJson(res, 200, { skills: await listCustomSkills(identity.userId) })
      let body: { name?: unknown; description?: unknown; content?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body', code: 'invalid_json' })
      }
      const checked = validateSkill(body.name, body, builtinSkillNames)
      if (!checked.ok) return sendJson(res, 400, { error: checked.error, code: checked.code })
      if ((await countCustomSkills(identity.userId)) >= MAX_SKILLS_PER_USER) {
        return sendJson(res, 409, { error: `at most ${MAX_SKILLS_PER_USER} skills per user`, code: 'skill_limit' })
      }
      const record = await createCustomSkill(identity.userId, checked.skill)
      if (!record) return sendJson(res, 409, { error: `skill "${checked.skill.name}" already exists`, code: 'skill_exists' })
      log('custom_skill_created', { userId: identity.userId, name: record.name })
      await pushSkills(identity.userId, await listSessionPlacementsForOwner(identity.userId))
      sendJson(res, 201, record)
    })
    return
  }

  const customSkillMatch = CUSTOM_SKILL_PATH.exec(url.pathname)
  if (customSkillMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    handle(res, async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const name = decodeURIComponent(customSkillMatch[1])
      if (req.method === 'DELETE') {
        if (!(await deleteCustomSkill(identity.userId, name))) {
          return sendJson(res, 404, { error: 'skill not found', code: 'skill_not_found' })
        }
        log('custom_skill_deleted', { userId: identity.userId, name })
        await pushSkills(identity.userId, await listSessionPlacementsForOwner(identity.userId))
        res.writeHead(204)
        res.end()
        return
      }
      let body: { description?: unknown; content?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body', code: 'invalid_json' })
      }
      const checked = validateSkill(name, body, builtinSkillNames)
      if (!checked.ok) return sendJson(res, 400, { error: checked.error, code: checked.code })
      const record = await updateCustomSkill(identity.userId, name, checked.skill)
      if (!record) return sendJson(res, 404, { error: 'skill not found', code: 'skill_not_found' })
      log('custom_skill_updated', { userId: identity.userId, name })
      await pushSkills(identity.userId, await listSessionPlacementsForOwner(identity.userId))
      sendJson(res, 200, record)
    })
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
}

// Role gate, in front of every route (one place instead of a check in each of ~30 handlers). Two roles:
//   admin — everything;
//   user  — chats, own projects/files/skills, and their own Data Studio dashboards and charts.
// Admin-only: every /data-studio/* route except the per-user dashboards and charts (semantic-layer edits, Dremio
// browse/sync, the catalog itself — which would reveal tables a user may not query —, the data profile), creating
// accounts (no self-registration) and managing users.
// 2026-10-07: dashboards and the charts on them are per user (owner_id; docs/data-studio-user-dashboards-plan.md) —
// every route below checks ownership itself, so role `user` may use them fully (was: read-only, every dashboard).
const USER_DATA_STUDIO_PATHS = [
  /^\/data-studio\/dashboards$/,
  /^\/data-studio\/dashboards\/[^/]+$/,
  /^\/data-studio\/dashboards\/[^/]+\/(widgets|charts)$/,
  /^\/data-studio\/dashboards\/meta\/available-charts$/,
  /^\/data-studio\/charts\/[^/]+$/,
]
const ADMIN_ONLY_PATHS = [/^\/auth\/register$/, /^\/users$/, /^\/users\/[^/]+$/]

function needsAdmin(req: IncomingMessage, pathname: string): boolean {
  if (req.method === 'OPTIONS') return false
  if (pathname.startsWith('/data-studio/')) return !USER_DATA_STUDIO_PATHS.some((re) => re.test(pathname))
  return ADMIN_ONLY_PATHS.some((re) => re.test(pathname))
}

async function adminGate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!needsAdmin(req, url.pathname)) return true
  const identity = await identityFromRequest(req, url)
  if (identity?.role === 'admin') return true
  res.setHeader('access-control-allow-origin', '*')
  log('admin_gate_denied', { path: url.pathname, method: req.method, userId: identity?.userId })
  sendJson(res, identity ? 403 : 401, identity ? { error: 'admin role required', code: 'forbidden' } : { error: 'unauthorized' })
  return false
}

const server = createServer((req, res) => {
  adminGate(req, res).then(
    (allowed) => {
      if (allowed) route(req, res)
    },
    (error: unknown) => {
      log('admin_gate_failed', { error: String(error) })
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    },
  )
})

// Performance fix 2026-09-09 (docs/security-performance-review-2026-09-09.md
// finding #8, found while designing that fix): the browser-facing socket
// had no `maxPayload` either — same gap already closed on the worker-facing
// side (packages/agent-core/src/transport/server.ts's own `MAX_FRAME_BYTES`), same
// value, mirrored here rather than imported (services/* never import each
// other's internals, docs/code-rules.md §1 — this is the same class of
// bound, not shared state).
const MAX_FRAME_BYTES = 100 * 1024
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

// Browsers can't set custom headers on the WS upgrade request, so the token
// travels as a query param here (?token=...) rather than an Authorization
// header — same constraint that pushed dsh-web-app's own remote.mux route to
// a comparable scheme (docs/code-rules.md §15).
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = /^\/sessions\/(.+)$/.exec(url.pathname)

  void (async () => {
    // a single-use ticket from POST /auth/ws-ticket, never the login token itself (it would sit in access logs)
    const ticket = url.searchParams.get('ticket')
    const redeemed = match && ticket ? await redeemWsTicket(ticket) : undefined
    const identity = redeemed?.identity
    if (!match || !identity) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const reject = (status: string, event: string, fields: Record<string, unknown> = {}) => {
      log(event, { userId: identity.userId, ...fields })
      socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
      socket.destroy()
    }

    const isNew = match[1] === 'new'
    // A brand-new session's id is decided here, before routing: the row (flow/model/owner) is written under
    // it, and the runtime is told it with the first connect (proxy.ts stays byte-blind).
    const sessionId = isNew ? randomUUID() : match[1]
    // Only a reconnect carries an id from the client; it is used to build filesystem paths further down.
    if (!isNew && !SESSION_ID_RE.test(sessionId)) return reject('400 Bad Request', 'ws_bad_session_id')

    // A reconnect to an EXISTING session must be owned by this identity (or the identity must be admin).
    if (!isNew && !(await canAccessSession(identity, sessionId))) return reject('403 Forbidden', 'ws_forbidden', { sessionId })

    // Everything the runtime needs to (re)open the session comes from the database row, never from the
    // reconnect's URL: flow, model, project and owner are chosen once, at creation.
    let session: { ownerId: number; flow: string; model: string | undefined; projectId: string | undefined }
    if (isNew) {
      const model = url.searchParams.get('model') ?? undefined
      const projectId = url.searchParams.get('project') ?? undefined
      // a chat inside a project must be in the caller's own project, and is always a data-analysis chat
      if (projectId !== undefined && !(await canAccessProject(identity, projectId))) return reject('403 Forbidden', 'ws_forbidden_project', { projectId })
      const flow = projectId !== undefined ? 'data-analysis' : (url.searchParams.get('flow') ?? 'default')
      if (!config.allowedFlows.includes(flow)) return reject('400 Bad Request', 'ws_invalid_flow', { flow })
      if (model !== undefined && !config.allowedModels.includes(model)) return reject('400 Bad Request', 'ws_invalid_model', { model })
      session = { ownerId: identity.userId, flow, model, projectId }
    } else {
      const row = await getSessionRuntimeInfo(sessionId)
      if (!row) return reject('404 Not Found', 'ws_unknown_session', { sessionId })
      session = row
      // a log that left the disk (docs/session-archive-plan.md) comes back from S3 before the runtime reads it
      await ensureSessionLogLocal(sessionId, row.ownerId).catch((error: unknown) =>
        log('session_restore_failed', { sessionId, error: error instanceof Error ? error.message : String(error) }),
      )
    }

    // The OWNER's role decides what this session's agent may touch (Data Studio data — python/src/security/role.py).
    // Owner, not viewer: it must match the workspace and the user id, and not depend on who connected first. For a
    // new session the owner is the caller. A missing account reads as 'user' (least privilege).
    const ownerRole: Role = isNew ? identity.role : ((await getUserById(session.ownerId))?.role ?? 'user')

    // Concurrent-session quota — only a NEW live session counts; one already live is never turned away.
    const quota = checkQuota(sessionId, session.ownerId)
    if (!quota.ok) return reject('429 Too Many Requests', 'ws_quota_rejected', { sessionId, reason: quota.reason })

    let target
    let placement
    try {
      placement = placementFor(session, sessionId)
      await ensurePlacement(placement)
      target = await runtime.target(sessionId)
    } catch (error) {
      console.error(`[gateway] runtime target for ${sessionId} failed:`, error)
      return reject('502 Bad Gateway', 'ws_runtime_unavailable', { sessionId, error: String(error) })
    }

    if (isNew) await createSession(sessionId, identity.userId, session.flow, session.projectId, session.model)

    // Per-user skills must be on disk before the first message.
    await pushSkills(session.ownerId, [{ sessionId, projectId: session.projectId }])

    wss.handleUpgrade(req, socket, head, (browserWs) => {
      log('ws_connect', { sessionId, isNew, userId: identity.userId, flow: session.flow, shard: target.shard })
      const untrack = trackConnection(sessionId, session.ownerId)
      browserWs.on('close', () => {
        untrack()
        log('ws_disconnect', { sessionId })
      })

      // What the runtime must know to open this session, sent on EVERY connect so it keeps no control state
      // of its own: restart it, change the shard count, and the next connect re-establishes everything.
      const params = new URLSearchParams({ flow: session.flow, cwd: placement.cwd, user: String(session.ownerId), role: ownerRole })
      if (session.model !== undefined) params.set('model', session.model)
      if (placement.outputDir !== undefined) params.set('output', placement.outputDir)
      if (isNew) params.set('id', sessionId)
      const workerUrl = `ws://${target.host}:${target.port}/sessions/${isNew ? 'new' : sessionId}?${params}`

      // The socket was opened with a ticket; its login token is known here only by hash (redis.ts).
      const tokenHash = redeemed!.tokenHash
      // First client frame = a real message: the session now shows in the sidebar. Every client frame
      // renews the sliding login token and the sidebar sort order (a bare open of an old chat must not
      // re-sort it, docs/code-rules.md 2026-09-10).
      proxyToWorker(
        browserWs,
        workerUrl,
        () => void markSessionFirstMessage(sessionId),
        () => {
          void touchSessionRow(sessionId)
          void renewTokenHash(tokenHash, config.tokenTtlMs)
        },
        runtime.headers,
        // per-user chat rate limit (2026-10-06): every message starts an LLM turn; `cancel` is never refused
        async (frame) => {
          let type: unknown
          try {
            type = (JSON.parse(frame) as { type?: unknown }).type
          } catch {
            return undefined // not JSON: the runtime answers it
          }
          if (type !== 'followup' && type !== 'steer') return undefined
          if (await checkRateLimit('chat', String(identity.userId), config.chatRateLimitMax, 60_000)) return undefined
          log('chat_rate_limited', { userId: identity.userId, sessionId })
          return `Too many messages: at most ${config.chatRateLimitMax} per minute. Wait a moment and send it again.`
        },
      )
    })
  })().catch((error: unknown) => {
    log('ws_upgrade_failed', { error: error instanceof Error ? error.message : String(error) })
    if (socket.writable) socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
    socket.destroy()
  })
})

// Data Studio's MongoDB (docs/data-studio-mongodb-plan.md). Non-fatal on purpose: chat, auth and
// projects don't need it, so an unreachable Mongo only breaks the /data-studio/* routes (which then
// fail per request) instead of taking the whole gateway down.
void checkMongoConnection()
  .then(async (ok) => {
    log('mongo_check', { ok })
    if (ok) await ensureIndexes()
  })
  .catch((error: unknown) => log('mongo_check', { ok: false, error: error instanceof Error ? error.message : String(error) }))

// Readiness is "this process AND its runtime(s) can take a chat"; liveness is just "this process answers".
// (Both are matched before authentication, ahead of the router above, by wrapping the listener below.)
async function main(): Promise<void> {
  await runtime.start()
  await startArchiver()
  server.listen(config.port, () => {
    console.log(`[gateway] listening on http://127.0.0.1:${config.port}; ${config.runtimeCount} agent runtime(s), data in ${config.dataDir}`)
  })
}

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log('shutdown', { signal, liveSessions: liveCount() })
  // Stop taking connections, let the runtimes flush every session log (they do it on idle and on SIGTERM), exit.
  server.close()
  for (const client of wss.clients) client.close(1001, 'server shutting down')
  stopAdminWorker()
  await runtime.stop()
  await stopArchiver() // the runtimes have flushed: archive the last turns
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// Last line of defence. The mongodb driver rejects promises nobody holds when a connect fails while operations are
// queued (MongoTopologyClosedError from Topology.close draining its wait queue) — Node's default would exit and drop
// every live chat. Log it; the request that hit it already got its error.
process.on('unhandledRejection', (reason: unknown) => {
  log('unhandled_rejection', { error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason) })
})

main().catch((error: unknown) => {
  console.error('[gateway] failed to start:', error)
  void runtime.stop().finally(() => process.exit(1))
})
