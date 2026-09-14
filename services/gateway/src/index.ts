// Auth, token issuance, routing + affinity, streaming fan-out (roadmap
// §1.2). MUST NOT import from any `@fox-harness/dsh-*`
// package — only @fox-harness/contracts (docs/code-rules.md §1). Must never
// run agent logic itself: this process only issues tokens and relays raw WS
// frames to packages/transport (see proxy.ts) — packages/transport has no
// auth of its own and expects to sit behind exactly this.
//
// Phase 7: real accounts + 2 roles (admin, user), replacing the single
// shared-operator-secret model Phase 2-6 used. Gateway is the SOLE
// authorization enforcer (docs/agent-core-architecture-roadmap.md's Phase 7
// architecture decision) — services/orchestrator does no auth checks of its
// own, same as before; every route below now resolves a real identity and
// checks it before proxying anywhere.

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'

import { login, logout, register, resolveIdentity, type AuthedIdentity } from './auth.ts'
import { config } from './config.ts'
import {
  countCustomSkills,
  createCustomSkill,
  createSession,
  deleteCustomSkill,
  deleteSessionRow,
  getSessionOwnerId,
  listCustomSkills,
  listSessionIdsForOwner,
  listSessionOwners,
  listSessionsForOwner,
  listUsers,
  markSessionFirstMessage,
  renameSession,
  touchSessionRow,
  updateCustomSkill,
  type Role,
} from './db.ts'
import { ensureSession, fetchModels, OrchestratorHttpError, purgeSession, syncSkills, touchSession } from './orchestrator-client.ts'
import { proxyToWorker } from './proxy.ts'
import { checkRateLimit, getLiveSessionStatuses, renewToken } from './redis.ts'
import { loadBuiltinSkills, MAX_SKILLS_PER_USER, validateSkill } from './skills.ts'

// Phase 6 checklist item 2: cross-layer telemetry, tagged with sessionId.
// Same structured-JSON-to-stdout convention duplicated in
// services/orchestrator (see that service's index.ts for why this isn't a
// shared import).
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'gateway', event, ...fields }))
}

// Security fix 2026-09-09: every real sessionId this repo ever produces is
// a `randomUUID()` output (WS upgrade handler, brand-new session branch) —
// this matches that exact shape. Applied at every entry point that reads a
// sessionId out of the URL path before it touches the DB or (via
// orchestrator) the filesystem, rejecting anything else with a real 400 —
// a malformed id (e.g. containing `../`) used to be able to reach
// `path.join(config.dataDir, sessionId)` on the orchestrator side.
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

const builtinSkills = loadBuiltinSkills()
const builtinSkillNames = new Set(builtinSkills.map((skill) => skill.name))

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Writes the owner's current skills into the given sessions' $DSH_HOME/skills
// (docs/skill-transfer-plan.md). A failure is logged, not surfaced: the skill
// is already saved in MariaDB, and the next WS connect syncs again.
async function pushSkills(ownerId: number, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  try {
    const skills = (await listCustomSkills(ownerId)).map(({ name, description, content }) => ({ name, description, content }))
    const synced = await syncSkills(config.orchestratorUrl, { sessionIds, skills })
    log('skills_sync_ok', { ownerId, synced: synced.length, skills: skills.length })
  } catch (error) {
    log('skills_sync_failed', { ownerId, error: String(error) })
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Every route below except /auth/register, /auth/login, /auth/logout,
// /models, and OPTIONS needs a real identity. Browsers can't set custom
// headers on a WS upgrade or a
// dynamically-`import()`-ed module (packages/transport/README.md's Phase 5
// note already established this for the WS case) — both fall back to a
// `?token=` query param, matching the one already-solved shape rather than
// inventing a second one. A normal `fetch()`-based route (manifest, plugin
// catalog, toggle, purge, admin listings) can and does use a real
// `Authorization: Bearer <token>` header (apps/web/src/main.ts sends it).
async function identityFromRequest(req: IncomingMessage, url: URL): Promise<AuthedIdentity | undefined> {
  const authHeader = req.headers.authorization
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined
  const token = bearerToken ?? url.searchParams.get('token') ?? undefined
  if (!token) return undefined
  return resolveIdentity(token)
}

// A session with no `session_owners` row (created before Phase 7, or some
// future race) falls through to "admin only" — the safe default, not a
// special case (infra/migrations/002_users_and_ownership.sql's own comment
// explains why this needs no separate migration/backfill step).
async function canAccessSession(identity: AuthedIdentity, sessionId: string): Promise<boolean> {
  if (identity.role === 'admin') return true
  const ownerId = await getSessionOwnerId(sessionId)
  return ownerId === identity.userId
}

function requireRole(identity: AuthedIdentity | undefined, role: Role): identity is AuthedIdentity {
  return !!identity && identity.role === role
}

const server = createServer((req, res) => {
  // apps/web is a separately-served static bundle (roadmap Phase 2 step 4),
  // so its origin differs from the gateway's in any real deployment — the
  // browser sends a CORS preflight before the real POST (application/json
  // isn't a CORS-safelisted content-type), and now also before a real
  // `Authorization` header (Phase 7 — also not a CORS-safelisted header).
  res.setHeader('access-control-allow-origin', '*')
  // Real bug fixed 2026-09-10 (user: "có rõ ràng mà bị lỗi cors" —
  // PATCH /sessions/:id, HistoryChat.tsx's rename): `PATCH` was missing
  // from this list since the route itself was added (Phase 12 item 2) —
  // the browser's CORS preflight (a real cross-origin request here, gateway
  // and apps/web on different ports) rejected the real PATCH before it
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

  // i18n (2026-09-10): `/auth/register`+`/auth/login` are the only 2 routes
  // whose `error` string is actually shown to a user today (apps/web's
  // ConnectForm) — every error response from THESE 2 routes now also sends
  // a stable `code` alongside the existing `error` string, so apps/web can
  // show it in whichever language is selected instead of always English.
  // Purely additive: `error` is unchanged (still the real fallback FE uses
  // for a `code` it doesn't recognize), no status code or behavior change.
  // Every other route below (session management, plugin inventory,
  // admin...) is deliberately NOT touched — none of their errors are
  // surfaced to a user anywhere yet (console-only), so a `code` there would
  // be speculative, not a real need.
  if (req.method === 'POST' && url.pathname === '/auth/register') {
    void (async () => {
      // Security fix 2026-09-09: no rate-limit existed here at all before —
      // checked first, before even reading the body, so a hammered client
      // doesn't cost more than 1 Redis round trip per attempt.
      const registerIp = req.socket.remoteAddress ?? 'unknown'
      if (!(await checkRateLimit('register', registerIp, config.authRateLimitMax, config.authRateLimitWindowMs))) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'too many attempts, try again shortly', code: 'rate_limited' }))
        return
      }
      let body: { email?: unknown; password?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON body', code: 'invalid_json' }))
        return
      }
      if (typeof body.email !== 'string' || typeof body.password !== 'string' || body.password.length < 8) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ error: 'email and a password of at least 8 characters are required', code: 'invalid_registration_input' }),
        )
        return
      }
      try {
        const user = await register(body.email, body.password)
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
    })()
    return
  }

  if (req.method === 'POST' && url.pathname === '/auth/login') {
    void (async () => {
      // Security fix 2026-09-09: separate bucket from /auth/register (same
      // reasoning as that route's own comment) — a login brute-force
      // attempt shouldn't also lock a real user out of registering.
      const loginIp = req.socket.remoteAddress ?? 'unknown'
      if (!(await checkRateLimit('login', loginIp, config.authRateLimitMax, config.authRateLimitWindowMs))) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'too many attempts, try again shortly', code: 'rate_limited' }))
        return
      }
      let body: { email?: unknown; password?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON body', code: 'invalid_json' }))
        return
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
    })()
    return
  }

  // Phase 12: real gap found while checking the FE's login/logout flow —
  // `src/auth.ts`'s `logout()` (revokes the token in Redis, Phase 7) had
  // ZERO callers anywhere in this codebase. The FE's old "Disconnect"
  // button only ever closed the WebSocket and re-showed the login form —
  // the token stayed valid (and stayed in sessionStorage) the whole time,
  // so a reload while the tab was still open would silently reconnect with
  // the "logged out" session. This route + apps/web's rewired logout button
  // (main.ts) close that gap for real.
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    void (async () => {
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
    })()
    return
  }

  // Follow-up (2026-09-08): the boot manifest + per-plugin client.js proxy
  // routes that used to live here (Phase 4-12) are REMOVED along with the
  // whole per-session dynamically-composed UI plugin mechanism — see
  // apps/web/README.md. `apps/web` is now one single, normally-built React
  // app served as a static bundle, same for every user.
  //
  // Session-scoped (ownership-or-admin), proxied to whichever worker
  // `ensureSession` says is live for it — the one piece of that whole
  // mechanism still worth keeping (a genuinely useful diagnostic, unrelated
  // to how the FE is delivered).
  const pluginInventoryMatch = PLUGIN_INVENTORY_PATH.exec(url.pathname)
  if (req.method === 'GET' && pluginInventoryMatch) {
    void (async () => {
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
      if (!(await canAccessSession(identity, sessionId))) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      try {
        const target = await ensureSession(config.orchestratorUrl, sessionId)
        const workerRes = await fetch(`http://${target.host}:${target.port}/plugin-inventory`)
        const body = await workerRes.text()
        res.writeHead(workerRes.status, { 'content-type': 'application/json' })
        res.end(body)
      } catch (error) {
        console.error(`[gateway] plugin-inventory(${sessionId}) failed:`, error)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'failed to fetch plugin inventory' }))
      }
    })()
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
  // never proxied anywhere; orchestrator has no "list every session" route
  // of its own (roadmap: orchestrator "không biết nội dung session", and a
  // full session list is exactly that kind of thing gateway shouldn't push
  // down into it just for this).
  if (req.method === 'GET' && url.pathname === '/users') {
    void (async () => {
      const identity = await identityFromRequest(req, url)
      if (!requireRole(identity, 'admin')) {
        res.writeHead(identity ? 403 : 401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: identity ? 'admin role required' : 'unauthorized' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(await listUsers()))
    })()
    return
  }

  if (req.method === 'GET' && url.pathname === '/sessions') {
    void (async () => {
      const identity = await identityFromRequest(req, url)
      if (!requireRole(identity, 'admin')) {
        res.writeHead(identity ? 403 : 401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: identity ? 'admin role required' : 'unauthorized' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(await listSessionOwners()))
    })()
    return
  }

  // Phase 12 item 2: the route that didn't exist AT ALL before this phase —
  // any authenticated user (not just admin, unlike GET /sessions above) can
  // list their OWN sessions. Status is joined in live from Redis (Phase 12's
  // own design note: orchestrator's SessionRecord.status stays the one
  // source of truth, the database never duplicates it) — a session with no live
  // Redis record yet (never spawned) or one whose record expired reads as
  // 'hibernated', the safe default for "not currently running".
  if (req.method === 'GET' && SESSION_MINE_PATH.test(url.pathname)) {
    void (async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const rows = await listSessionsForOwner(identity.userId)
      const statuses = await getLiveSessionStatuses(rows.map((row) => row.sessionId))
      const withStatus = rows.map((row) => ({ ...row, status: statuses.get(row.sessionId) ?? 'hibernated' }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(withStatus))
    })()
    return
  }

  // Phase 12 item 4: static config, no identity/ownership check at all —
  // unlike every other route here, this one must be readable BEFORE login
  // (apps/web's connect-form populates the model picker on page load, before
  // any token exists — see apps/web/src/main.ts). Same "not dangerous on its
  // own" reasoning already applied to plugin-catalog browsing, just without
  // even the identity requirement that has, since there's no earlier point
  // in the flow to get one from.
  if (req.method === 'GET' && MODELS_PATH.test(url.pathname)) {
    void (async () => {
      try {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ models: await fetchModels(config.orchestratorUrl) }))
      } catch (error) {
        console.error('[gateway] models() failed:', error)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'failed to reach orchestrator' }))
      }
    })()
    return
  }

  // Phase 12 item 2: rename — the sidebar session-list's one write action
  // besides switch/create. Ownership-or-admin, same check as purge below.
  const renameMatch = req.method === 'PATCH' ? SESSION_RENAME_PATH.exec(url.pathname) : null
  if (renameMatch) {
    void (async () => {
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
      let body: { title?: unknown }
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
      await renameSession(sessionId, title)
      log('rename_ok', { sessionId, userId: identity.userId })
      res.writeHead(204)
      res.end()
    })()
    return
  }

  // Phase 6 checklist item 4: real delete-on-request — proxied straight to
  // the orchestrator's own purge route (see orchestrator-client.ts), plus
  // (Phase 7) gateway's own ownership-row cleanup so a purged-then-reused
  // session id never inherits stale ownership.
  const purgeMatch = SESSION_PURGE_PATH.exec(url.pathname)
  if (req.method === 'DELETE' && purgeMatch) {
    void (async () => {
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
        await purgeSession(config.orchestratorUrl, sessionId)
        await deleteSessionRow(sessionId)
        log('purge_ok', { sessionId, userId: identity.userId })
        res.writeHead(204)
        res.end()
      } catch (error) {
        const status = error instanceof OrchestratorHttpError ? error.status : 502
        log('purge_failed', { sessionId, error: String(error) })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'failed to purge session' }))
      }
    })()
    return
  }

  // Per-user skills (docs/skill-transfer-plan.md). `GET /skills` feeds the "/"
  // menu: built-in skills a user may invoke directly + the user's own.
  if (req.method === 'GET' && url.pathname === '/skills') {
    void (async () => {
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
    })()
    return
  }

  if (url.pathname === '/custom-skills' && (req.method === 'GET' || req.method === 'POST')) {
    void (async () => {
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
      await pushSkills(identity.userId, await listSessionIdsForOwner(identity.userId))
      sendJson(res, 201, record)
    })()
    return
  }

  const customSkillMatch = CUSTOM_SKILL_PATH.exec(url.pathname)
  if (customSkillMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    void (async () => {
      const identity = await identityFromRequest(req, url)
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      const name = decodeURIComponent(customSkillMatch[1])
      if (req.method === 'DELETE') {
        if (!(await deleteCustomSkill(identity.userId, name))) {
          return sendJson(res, 404, { error: 'skill not found', code: 'skill_not_found' })
        }
        log('custom_skill_deleted', { userId: identity.userId, name })
        await pushSkills(identity.userId, await listSessionIdsForOwner(identity.userId))
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
      await pushSkills(identity.userId, await listSessionIdsForOwner(identity.userId))
      sendJson(res, 200, record)
    })()
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

// Performance fix 2026-09-09 (docs/security-performance-review-2026-09-09.md
// finding #8, found while designing that fix): the browser-facing socket
// had no `maxPayload` either — same gap already closed on the worker-facing
// side (packages/transport/src/server.ts's own `MAX_FRAME_BYTES`), same
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
    const identity = match ? await identityFromRequest(req, url) : undefined
    if (!match || !identity) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    const isNew = match[1] === 'new'
    // A brand-new session's id must be decided HERE, before routing — the
    // orchestrator needs it to register Redis affinity, and packages/transport
    // no longer gets to mint it unobserved (proxy.ts stays deliberately
    // byte-blind, so gateway can't just "read" an id back out of the first
    // frame either — see packages/transport/README.md's `?id=` note).
    const sessionId = isNew ? randomUUID() : match[1]

    // Security fix 2026-09-09: only meaningful for a reconnect — `isNew`'s
    // sessionId is always a freshly-generated randomUUID() above, already
    // valid by construction. A malformed reconnect id (e.g. containing
    // `../`) used to be able to reach path.join(dataDir, sessionId) on the
    // orchestrator side via the "brand new" fallback (see SESSION_ID_RE's
    // own comment).
    if (!isNew && !SESSION_ID_RE.test(sessionId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    // Phase 7: a reconnect to an EXISTING session must be owned by this
    // identity (or the identity must be admin) — a brand-new session has no
    // owner yet, so there's nothing to check until after it's created below.
    if (!isNew && !(await canAccessSession(identity, sessionId))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    // Phase 12 item 4: only meaningful for a brand-new session — an
    // existing session's rehydrate reuses the model it was created with
    // (services/orchestrator/src/ensure.ts), not whatever this reconnect's
    // URL happens to carry.
    const model = url.searchParams.get('model') ?? undefined
    // Same rule as `model` above, for which agent loop/profile to spawn a
    // brand-new session with (docs/data-analysis-flow-plan.md) — a
    // reconnect/rehydrate always reuses the session's original flow instead.
    const flow = url.searchParams.get('flow') ?? undefined

    let target
    try {
      target = await ensureSession(config.orchestratorUrl, sessionId, isNew ? model : undefined, isNew ? flow : undefined)
    } catch (error) {
      // Phase 6 checklist item 1: a quota rejection (orchestrator's 429,
      // services/orchestrator/src/errors.ts's QuotaExceededError) is an
      // expected outcome under load, not a gateway/orchestrator fault —
      // surface it as 429, not the generic 502 every other failure gets.
      if (error instanceof OrchestratorHttpError && error.status === 429) {
        log('ws_quota_rejected', { sessionId })
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return
      }
      // Phase 12 item 4: orchestrator's 400 (InvalidModelError — a `model`
      // outside its configured allow-list) is a client bug, not a gateway/
      // orchestrator fault, same treatment as the 429 case above.
      if (error instanceof OrchestratorHttpError && error.status === 400) {
        log('ws_invalid_model', { sessionId })
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }
      console.error(`[gateway] ensureSession(${sessionId}) failed:`, error)
      log('ws_ensure_failed', { sessionId, error: String(error) })
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
      return
    }

    if (isNew) await createSession(sessionId, identity.userId, flow ?? 'default')

    // Per-user skills must be on disk before the first message: a warm-pool
    // container booted before anyone owned it (docs/skill-transfer-plan.md).
    const skillOwnerId = isNew ? identity.userId : await getSessionOwnerId(sessionId)
    if (skillOwnerId !== undefined) await pushSkills(skillOwnerId, [sessionId])

    wss.handleUpgrade(req, socket, head, (browserWs) => {
      log('ws_connect', { sessionId, isNew, userId: identity.userId })
      touchSession(config.orchestratorUrl, sessionId, 'connected')
      browserWs.on('close', () => {
        log('ws_disconnect', { sessionId })
        touchSession(config.orchestratorUrl, sessionId, 'disconnected')
      })

      const workerPath = isNew ? `new?id=${sessionId}` : sessionId
      const workerUrl = `ws://${target.host}:${target.port}/sessions/${workerPath}`
      // WS upgrades only ever carry the token as `?token=` (browsers can't
      // set custom headers on an upgrade request, same reason
      // `identityFromRequest` falls back to this for the WS case) — safe to
      // re-read directly rather than threading it back out of that function.
      const token = url.searchParams.get('token') ?? ''
      // 2026-09-09: marks the session as real (infra/migrations/001_init.sql)
      // the first time the user actually sends something — see db.ts's own
      // comment on why `GET /sessions/mine` filters on this instead of
      // just existing. Second callback (2026-09-10, folds in a real bug
      // fix — see below): sliding token expiration (renews on every real
      // client message, not just the first, for a long session with no
      // other REST call in between — redis.ts's `renewToken`) AND the
      // sidebar sort-order touch.
      //
      // Real bug fixed 2026-09-10 ("chọn 1 trong các đoạn chat list này sẽ
      // bị nhảy"): `touchSessionRow` used to fire unconditionally right on
      // WS connect (`touchSession(...)` right above, a DIFFERENT function —
      // that one pings the ORCHESTRATOR to keep the worker container awake
      // while connected, unrelated to sort order, stays as-is). That meant
      // merely clicking an old chat in the sidebar to READ it — no message
      // sent — bumped `updated_at` to now(), so `SessionList.tsx`'s refetch
      // (fires on every `sessionId` change) re-sorted that exact row to the
      // top of "Today" an instant after the click, visibly jumping out from
      // under the cursor. Real chat apps (claude.ai, chat.deepseek.com)
      // only re-sort on actual send activity, not on opening a chat to view
      // it. Moved to this callback instead — same real-activity signal
      // `markSessionFirstMessage` already uses, fires on every message (not
      // just the first) so an old chat you actually resume chatting in
      // still climbs back to the top, just not from a bare open.
      proxyToWorker(
        browserWs,
        workerUrl,
        () => void markSessionFirstMessage(sessionId),
        () => {
          void touchSessionRow(sessionId)
          void renewToken(token, config.tokenTtlMs)
        },
      )
    })
  })()
})

server.listen(config.port, () => {
  console.log(`[gateway] listening on http://127.0.0.1:${config.port} -> orchestrator ${config.orchestratorUrl}`)
})
