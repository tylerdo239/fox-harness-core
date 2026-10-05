/**
 * Real WebSocket event stream + command endpoint, run inside the harness
 * worker (roadmap Phase 2 step 1). Design mirrors the real pattern found in
 * upstream's own browser transport (`packages/api/session-controller`'s
 * `follow()`, studied from real source, not copied — that code is
 * same-process-coupled and not directly reusable, see
 * docs/code-rules.md §15): **snapshot-then-live**, not a resume-from-cursor
 * protocol — a reconnect (e.g. a page reload) just opens a fresh logical
 * connection and gets a fresh complete snapshot + continuation. This is also
 * what makes the Phase 2 replay test correct: log-before-fanout falls out
 * for free from subscribing to the real `session/event` Cordis event, whose
 * own doc comment says the callback fires strictly after the durable append
 * commits — we don't have to get that ordering right ourselves.
 *
 * One WS connection = one session. Path `/sessions/new` mints a fresh
 * session (`ctx.agents.create()`) and replies with its id first so the
 * client can persist it (e.g. localStorage) and reconnect to
 * `/sessions/<id>` after a reload. This is deliberately NOT Typert's
 * multiplexed-single-connection design (docs/code-rules.md §0.3) — a
 * thinner protocol for the worker↔gateway hop, which is genuinely new work
 * upstream has no equivalent for (upstream is single-process, browser talks
 * directly to the one local harness).
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { WebSocketServer, type WebSocket } from 'ws'

import { FLOW_RE, joinFlow } from './flows.ts'

type ClientToServer = { type: 'followup'; text: string } | { type: 'steer'; text: string } | { type: 'cancel' }

// Performance fix 2026-09-09 (docs/security-performance-review-2026-09-09.md
// finding #5): neither bound existed before — a real cost-abuse vector, a
// valid logged-in user could send arbitrarily large/frequent messages with
// nothing between them and a real, costly LLM call. `MAX_FRAME_BYTES`
// bounds the raw WS frame (rejected by `ws` itself before this file's own
// message handler even runs); `MAX_TEXT_LENGTH` bounds the actual message
// content once parsed.
const MAX_FRAME_BYTES = 100 * 1024
const MAX_TEXT_LENGTH = 50_000

type ServerToClient =
  | { type: 'session'; sessionId: string }
  | { type: 'snapshot'; events: readonly unknown[] }
  | { type: 'event'; event: unknown }
  | { type: 'error'; message: string }

function send(ws: WebSocket, frame: ServerToClient): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
}

// Phase 6 checklist item 2: cross-layer telemetry, tagged with sessionId —
// the worker-side leg of gateway -> orchestrator -> worker (see
// services/gateway/src/index.ts and services/orchestrator/src/index.ts for
// the other two; same structured-JSON convention, duplicated per this
// project's established "mirrored, not imported" boundary rule).
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'transport', event, ...fields }))
}

function toUserMessage(text: string): UserMessage {
  return {
    id: randomUUID() as MessageId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Everything one runtime keeps about its live sessions. ONE `session/event`
 * listener for the whole process fans out through `subscribers` — the earlier
 * "one listener per connection, filtered by id" shape made every event cost
 * O(connections), which does not survive many sessions in one process.
 */
class Hub {
  readonly subscribers = new Map<SessionId, Set<WebSocket>>()
  readonly handles = new Map<SessionId, AgentHandle>()
  readonly lastActive = new Map<SessionId, number>()
  /** Single-flight: concurrent connects to one id share one create/resume. */
  private readonly inflight = new Map<SessionId, Promise<Session | undefined>>()

  constructor(private readonly ctx: Context) {}

  touch(sessionId: SessionId): void {
    this.lastActive.set(sessionId, Date.now())
  }

  /** The live session, or one resumed from disk / created fresh. `undefined` = unknown session. */
  ensure(sessionId: SessionId, opts: ConnectionParams & { isNew: boolean }): Promise<Session | undefined> {
    const live = this.ctx.sessions.get(sessionId)
    // Defence in depth behind the gateway's own ownership check: a session already live in this
    // process remembers who opened it, and another user's connect is refused outright.
    const liveOptions = this.ctx.agents.get(sessionId)?.options as { userId?: string; role?: string } | undefined
    if (live && liveOptions?.userId !== undefined && opts.userId !== undefined && liveOptions.userId !== opts.userId) {
      return Promise.reject(new Error('session belongs to another user'))
    }
    // The role was fixed when the agent was opened (tools read it from agent.options). A different role for the
    // same live session — the owner was promoted/demoted meanwhile — must not silently keep the old one: refuse,
    // and let the session be reopened once nobody is attached (idle disposal) with the new role.
    if (live && liveOptions?.role !== undefined && liveOptions.role !== opts.role) {
      return Promise.reject(new Error('session is open with a different role; reconnect later'))
    }
    if (live && !opts.isNew) return Promise.resolve(live)
    const pending = this.inflight.get(sessionId)
    if (pending) return pending
    const work = this.open(sessionId, opts).finally(() => this.inflight.delete(sessionId))
    this.inflight.set(sessionId, work)
    return work
  }

  private async open(sessionId: SessionId, opts: ConnectionParams & { isNew: boolean }): Promise<Session | undefined> {
    const ctx = this.ctx
    // `userId` / `outputDir` are not part of dsh's typed AgentOptions (provider/model/maxTokens) but
    // the type is merge-extensible and the object is what tools see as `agent.options`, which is
    // how python-repl learns its per-session output folder. Not persisted: the gateway sends them
    // again on every connect, which is also what makes a restarted runtime need no memory of them.
    const agentOptions = {
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
      role: opts.role,
      ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
    }
    const setup = (agentCtx: Context) => joinFlow(ctx, agentCtx, opts.flow)
    if (opts.isNew) {
      // Real gap found the hard way: omitting `meta.cwd` doesn't just leave
      // it blank — sessions land in a `_no-cwd` bucket in the log store
      // instead of the normal cwd-keyed directory, and per-session sandbox
      // tooling (dsh-sandbox-policy's workspaceRoot) has no per-session cwd
      // to use. Every real session-creating app sets this; ours must too.
      const handle = await ctx.agents.create({ sessionId, agentOptions, meta: { cwd: opts.cwd }, setup })
      this.handles.set(sessionId, handle)
      return handle.agent.session
    }
    const existing = ctx.sessions.get(sessionId)
    if (existing) return existing
    // Rehydrate (Phase 3): this process never saw the session created — the
    // expected shape after a restart or an idle dispose reattaches to a
    // session that lives only on disk. Falls through to `undefined` ("unknown
    // session") when it was never persisted.
    try {
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      this.handles.set(sessionId, handle)
      return handle.agent.session
    } catch (error) {
      log('resume_failed', { sessionId, error: String(error) })
      return undefined
    }
  }

  subscribe(sessionId: SessionId, ws: WebSocket): void {
    let set = this.subscribers.get(sessionId)
    if (!set) this.subscribers.set(sessionId, (set = new Set()))
    set.add(ws)
    this.touch(sessionId)
  }

  unsubscribe(sessionId: SessionId, ws: WebSocket): void {
    const set = this.subscribers.get(sessionId)
    if (!set) return
    set.delete(ws)
    if (set.size === 0) this.subscribers.delete(sessionId)
    this.touch(sessionId)
  }

  fanOut(sessionId: SessionId, event: unknown): void {
    this.touch(sessionId)
    const set = this.subscribers.get(sessionId)
    if (!set) return
    const frame = JSON.stringify({ type: 'event', event } satisfies ServerToClient) // serialized once for every subscriber
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(frame)
  }

  /**
   * Drop a session from this runtime: close its viewers and dispose its agent (flushing the log
   * first, which `disposeGracefully` does on idle). Used before the gateway deletes the session's
   * files, so a late flush cannot write the log back.
   */
  async drop(sessionId: SessionId): Promise<boolean> {
    for (const ws of [...(this.subscribers.get(sessionId) ?? [])]) ws.close(1000, 'session deleted')
    this.subscribers.delete(sessionId)
    const handle = this.handles.get(sessionId)
    this.handles.delete(sessionId)
    this.lastActive.delete(sessionId)
    if (!handle) return false
    await handle.dispose()
    return true
  }

  /** Free the RAM of sessions nobody watches and nothing is running in; they resume from disk on demand. */
  async disposeIdle(idleMs: number): Promise<number> {
    const now = Date.now()
    let disposed = 0
    for (const [sessionId, handle] of [...this.handles]) {
      if (this.subscribers.has(sessionId) || this.inflight.has(sessionId)) continue
      if (handle.agent.status !== 'idle') continue
      if (now - (this.lastActive.get(sessionId) ?? 0) < idleMs) continue
      this.handles.delete(sessionId)
      this.lastActive.delete(sessionId)
      try {
        await handle.dispose()
        disposed += 1
        log('session_disposed_idle', { sessionId })
      } catch (error) {
        log('session_dispose_failed', { sessionId, error: String(error) })
      }
    }
    return disposed
  }
}

interface ConnectionParams {
  /** Flow = agent preset id this agent joins (default: `default`). */
  flow: string
  /** Per-session model; the process-wide OPENAI_MODEL_ID is only the fallback. */
  model: string | undefined
  /** The session's working directory (becomes `session.header.cwd`). */
  cwd: string
  /** The gateway's user id of the owner; only used to refuse a different user on a live session. */
  userId: string | undefined
  /** The owner's role; tools that gate data on it (analyze_data) read it from agent.options. Default `user`. */
  role: 'admin' | 'user'
  /** Folder (relative to cwd) the python tool writes figures/artifacts to; a project chat's own subfolder. */
  outputDir: string | undefined
}

// Container-per-session mode (the pre-spike deployment) sets FOX_SESSION_CWD;
// a shared runtime gets the cwd per connection from the gateway instead. Either
// way the value ends up in `session.header.cwd`, which the sandbox policy, the
// python tool and skill discovery all TRUST — so a per-connection cwd must be
// proven to sit inside FOX_DATA_DIR, never taken as-is.
function parseParams(url: URL): ConnectionParams | { error: string } {
  const flow = url.searchParams.get('flow') ?? 'default'
  if (!FLOW_RE.test(flow)) return { error: `invalid flow "${flow}"` }
  const model = url.searchParams.get('model') ?? undefined
  if (model !== undefined && (model.length === 0 || model.length > 200)) return { error: 'invalid model' }

  const userId = url.searchParams.get('user') ?? undefined
  if (userId !== undefined && !/^[0-9]{1,12}$/.test(userId)) return { error: 'invalid user' }
  const roleParam = url.searchParams.get('role') ?? 'user'
  if (roleParam !== 'admin' && roleParam !== 'user') return { error: 'invalid role' }
  const role: 'admin' | 'user' = roleParam
  const outputDir = url.searchParams.get('output') ?? undefined
  // a relative path that cannot climb out of the session's folder
  if (outputDir !== undefined && !/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]{1,200}$/.test(outputDir)) return { error: 'invalid output' }

  const requestedCwd = url.searchParams.get('cwd')
  if (requestedCwd === null) return { flow, model, userId, role, outputDir, cwd: process.env.FOX_SESSION_CWD ?? process.cwd() }
  const root = process.env.FOX_DATA_DIR
  if (!root) return { error: 'cwd was supplied but FOX_DATA_DIR is not configured' }
  const base = resolve(root)
  const cwd = resolve(requestedCwd)
  if (cwd === base || !cwd.startsWith(base + sep)) return { error: 'cwd is outside FOX_DATA_DIR' }
  return { flow, model, userId, role, outputDir, cwd }
}

function internalSecretOk(req: IncomingMessage): boolean {
  const expected = process.env.FOX_INTERNAL_SECRET
  // Not configured: allowed only in the old one-session-per-container mode, where the loopback bind is the
  // boundary. A runtime shared by many users (FOX_DATA_DIR set by the gateway) must never run without it:
  // `role=admin` on the URL would otherwise be anyone's for the asking.
  if (!expected) return !process.env.FOX_DATA_DIR
  const given = req.headers['x-fox-harness-internal-secret']
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function handleConnection(ctx: Context, hub: Hub, ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = /^\/sessions\/(.+)$/.exec(url.pathname)
  if (!match) {
    send(ws, { type: 'error', message: `unknown path: ${url.pathname} (expected /sessions/new or /sessions/<id>)` })
    ws.close()
    return
  }
  const params = parseParams(url)
  if ('error' in params) {
    send(ws, { type: 'error', message: params.error })
    ws.close()
    return
  }

  const isNew = match[1] === 'new'
  // Phase 3: a caller-supplied id (services/gateway registers the session
  // BEFORE opening the connection — the proxy is deliberately byte-blind, so
  // it cannot "discover" an id minted here). Falls back to minting one when no
  // id is supplied (single-worker/local use).
  const sessionId = (isNew ? (url.searchParams.get('id') ?? randomUUID()) : match[1]) as SessionId

  // The message handler is attached BEFORE the (async) create/resume below and
  // frames are queued until the session is live. Joining a flow (preset mount)
  // takes real time now, and a client — the gateway forwards the user's first
  // message the instant its socket opens — can send before that finishes; a
  // handler attached afterwards silently dropped those frames.
  let live = false
  let closed = false
  const queued: Buffer[] = []
  const onMessage = (data: Buffer): void => {
    let frame: ClientToServer
    try {
      frame = JSON.parse(data.toString())
    } catch {
      send(ws, { type: 'error', message: 'invalid JSON frame' })
      return
    }
    if ((frame.type === 'followup' || frame.type === 'steer') && frame.text.length > MAX_TEXT_LENGTH) {
      send(ws, { type: 'error', message: `text too long (max ${MAX_TEXT_LENGTH} characters)` })
      return
    }
    const agent = ctx.agents.get(sessionId)
    if (!agent) {
      send(ws, { type: 'error', message: `no live agent for session ${sessionId}` })
      return
    }
    hub.touch(sessionId)
    if (frame.type === 'followup') agent.followup(toUserMessage(frame.text))
    else if (frame.type === 'steer') agent.steer(toUserMessage(frame.text))
    else if (frame.type === 'cancel') agent.cancel({ kind: 'user' })
    else send(ws, { type: 'error', message: `unknown frame type` })
  }
  ws.on('message', (data: Buffer) => {
    if (live) onMessage(data)
    else queued.push(data)
  })
  ws.on('close', () => {
    closed = true
    if (live) hub.unsubscribe(sessionId, ws)
    log('ws_disconnect', { sessionId })
  })

  let session: Session | undefined
  try {
    session = await hub.ensure(sessionId, { ...params, isNew })
  } catch (error) {
    send(ws, { type: 'error', message: `failed to create session: ${String(error)}` })
    ws.close()
    return
  }
  if (!session) {
    send(ws, { type: 'error', message: `unknown session: ${sessionId}` })
    ws.close()
    return
  }
  if (closed) return // the client left while the session was being set up
  if (isNew) send(ws, { type: 'session', sessionId })

  log('ws_connect', { sessionId, flow: params.flow, role: params.role })

  // Snapshot first — everything durable so far, verbatim, exactly as it would
  // read from disk — then subscribe, with NO await between the two so no event
  // can fall in the gap (and none is delivered twice).
  send(ws, { type: 'snapshot', events: session.events })
  hub.subscribe(sessionId, ws)
  live = true
  for (const data of queued.splice(0)) onMessage(data)
}

// Follow-up (2026-09-08): the whole "per-session, dynamically-composed UI
// plugin" delivery mechanism (Phase 4-12: boot manifest, per-plugin
// `client.js` bundles, the shared module loader, the slots outlet router)
// is REMOVED — the user decided it wasn't worth the complexity it kept
// causing (loading/caching bugs that were genuinely hard to debug without
// a real browser tool). `app` is now one single, normally-built React
// app shared by every user; UI features that used to be separate
// dynamically-loaded packages (session list, settings, plugin inventory,
// theme, conversation) are now just components inside that one app. This
// route (`GET /plugin-inventory`) is the one piece of that whole mechanism
// that's still real infrastructure worth keeping — a genuinely useful
// read-only diagnostic, unrelated to how the FE is delivered.
//
// Real Cordis introspection API used here (installed on every ctx,
// `node_modules/@deepseek-ai/cordis`'s real `.d.ts` — not guessed):
async function handleHttpRequest(ctx: Context, hub: Hub, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // Same boundary as the WebSocket upgrade: only the gateway (which holds the secret) may call any route.
  if (!internalSecretOk(req)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  // DELETE /sessions/<id>: forget a session in this runtime (purge). Never touches files; the
  // gateway deletes those afterwards.
  const dropMatch = /^\/sessions\/([0-9a-f-]{36})$/i.exec(url.pathname)
  if (req.method === 'DELETE' && dropMatch) {
    const dropped = await hub.drop(dropMatch[1] as SessionId)
    log('session_dropped', { sessionId: dropMatch[1], dropped })
    res.writeHead(204)
    res.end()
    return
  }

  // Read-only, live Cordis Loader/registry state — backs
  // `ctx.registry` API (installed on every ctx, `node_modules/@deepseek-ai/cordis`'s
  // real `.d.ts` — not guessed): `entries()` yields `[callback, Plugin.Runtime]`,
  // `runtime.fibers` is every live fiber of that plugin (normally exactly
  // one — `ctx.plugin()` called twice under different parents is the only
  // way to get more, which this project's own plugin composition never
  // does), each with a numeric `FiberState` (a `const enum`, so only the
  // inlined numbers are visible at runtime — mapped back to names here).
  if (req.method === 'GET' && url.pathname === '/plugin-inventory') {
    const FIBER_STATE_NAMES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const
    const rows: { moduleName: string; entryId: string; state: string }[] = []
    for (const [, runtime] of ctx.registry.entries()) {
      for (const fiber of runtime.fibers) {
        rows.push({
          moduleName: runtime.name ?? 'unknown',
          entryId: String(fiber.uid ?? '?'),
          state: FIBER_STATE_NAMES[fiber.state] ?? `unknown(${String(fiber.state)})`,
        })
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(rows))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
}

export function startTransportServer(ctx: Context, port: number, host: string): () => void {
  const hub = new Hub(ctx)
  const server = createServer((req, res) => {
    void handleHttpRequest(ctx, hub, req, res).catch((error: unknown) => {
      log('http_failed', { error: String(error) })
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  // The single fan-out listener (see Hub).
  const disposeListener = ctx.on('session/event', (eventSession, event) => hub.fanOut(eventSession.id, event))

  // Idle sessions give their RAM back; the log on disk is the source of truth
  // and the next connect resumes them.
  const idleMs = Number(process.env.FOX_IDLE_DISPOSE_MS ?? 10 * 60 * 1000)
  const sweepMs = Number(process.env.FOX_IDLE_SWEEP_MS ?? 30 * 1000)
  const sweep = idleMs > 0 ? setInterval(() => void hub.disposeIdle(idleMs), sweepMs) : undefined

  server.on('upgrade', (req, socket, head) => {
    if (!internalSecretOk(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConnection(ctx, hub, ws, req)
    })
  })
  server.on('error', (error) => {
    console.error('fox-harness-transport: server error:', error)
  })
  server.listen(port, host)

  return () => {
    if (sweep) clearInterval(sweep)
    disposeListener()
    server.close()
  }
}
