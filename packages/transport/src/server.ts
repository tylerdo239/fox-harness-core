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

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { WebSocketServer, type WebSocket } from 'ws'

type ClientToServer = { type: 'followup'; text: string } | { type: 'steer'; text: string }

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

async function handleConnection(ctx: Context, ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = /^\/sessions\/(.+)$/.exec(url.pathname)
  if (!match) {
    send(ws, { type: 'error', message: `unknown path: ${url.pathname} (expected /sessions/new or /sessions/<id>)` })
    ws.close()
    return
  }

  let sessionId: SessionId
  if (match[1] === 'new') {
    // Phase 3: a caller-supplied id (services/gateway, which must register
    // Redis affinity for a session BEFORE opening the connection — it can no
    // longer let this transport mint the id and "discover" it after the fact,
    // since the proxy is deliberately byte-blind, see services/gateway's
    // README). Falls back to minting one, unchanged from Phase 2 behavior,
    // when no id is supplied (single-worker/local use).
    const requestedId = url.searchParams.get('id')
    sessionId = (requestedId ?? randomUUID()) as SessionId
    try {
      // Real gap found the hard way: omitting `meta.cwd` doesn't just leave
      // it blank — sessions land in a `_no-cwd` bucket in the log store
      // instead of the normal cwd-keyed directory, and per-session sandbox
      // tooling (dsh-sandbox-policy's workspaceRoot) has no per-session cwd
      // to use. Every real session-creating app (dsh-headless, dsh-web-app)
      // sets this; our transport must too. `FOX_SESSION_CWD` is the flow's
      // working directory, set (and created) by services/orchestrator.
      await ctx.agents.create({ sessionId, agentOptions: {}, meta: { cwd: process.env.FOX_SESSION_CWD ?? process.cwd() } })
    } catch (error) {
      send(ws, { type: 'error', message: `failed to create session: ${String(error)}` })
      ws.close()
      return
    }
    send(ws, { type: 'session', sessionId })
  } else {
    sessionId = match[1] as SessionId
  }

  let session = ctx.sessions.get(sessionId)
  if (!session) {
    // Rehydrate (Phase 3): this process never saw the session created — the
    // expected shape after a container restart (kill -9, hibernate) reattaches
    // to a session that lives only on disk (the mounted log volume), not in
    // this fresh process's memory. Falls through to the same "unknown
    // session" error below when it's genuinely unknown (never persisted).
    try {
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: {} })
      session = handle.agent.session
    } catch {
      // not resumable — handled by the `!session` check below
    }
  }
  if (!session) {
    send(ws, { type: 'error', message: `unknown session: ${sessionId}` })
    ws.close()
    return
  }

  log('ws_connect', { sessionId })
  ws.on('close', () => log('ws_disconnect', { sessionId }))

  // Snapshot first — everything durable so far, verbatim, exactly as it
  // would read from disk. Then live: forward only this session's future
  // durable events (session/event fires for every session in this worker,
  // filtered here the same way dsh-core's agent/request listener filters
  // by env var — a plain ctx.on() at this plugin's own scope sees all of
  // them, per docs/code-rules.md).
  send(ws, { type: 'snapshot', events: session.events })

  const disposeListener = ctx.on('session/event', (eventSession, event) => {
    if (eventSession.id !== sessionId) return
    send(ws, { type: 'event', event })
  })

  ws.on('close', () => {
    disposeListener()
  })

  ws.on('message', (data) => {
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
    if (frame.type === 'followup') agent.followup(toUserMessage(frame.text))
    else if (frame.type === 'steer') agent.steer(toUserMessage(frame.text))
    else send(ws, { type: 'error', message: `unknown frame type` })
  })
}

// Follow-up (2026-09-08): the whole "per-session, dynamically-composed UI
// plugin" delivery mechanism (Phase 4-12: boot manifest, per-plugin
// `client.js` bundles, the shared module loader, the slots outlet router)
// is REMOVED — the user decided it wasn't worth the complexity it kept
// causing (loading/caching bugs that were genuinely hard to debug without
// a real browser tool). `apps/web` is now one single, normally-built React
// app shared by every user; UI features that used to be separate
// dynamically-loaded packages (session list, settings, plugin inventory,
// theme, conversation) are now just components inside that one app. This
// route (`GET /plugin-inventory`) is the one piece of that whole mechanism
// that's still real infrastructure worth keeping — a genuinely useful
// read-only diagnostic, unrelated to how the FE is delivered.
//
// Real Cordis introspection API used here (installed on every ctx,
// `node_modules/@deepseek-ai/cordis`'s real `.d.ts` — not guessed):
async function handleHttpRequest(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

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
  const server = createServer((req, res) => {
    void handleHttpRequest(ctx, req, res)
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConnection(ctx, ws, req)
    })
  })
  server.on('error', (error) => {
    console.error('fox-harness-transport: server error:', error)
  })
  server.listen(port, host)

  return () => {
    server.close()
  }
}
