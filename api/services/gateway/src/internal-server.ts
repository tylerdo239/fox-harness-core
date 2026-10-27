// The gateway's second listener: 127.0.0.1 only, never behind nginx/ingress, every request carries the secret the
// gateway gave its runtimes (runtime/supervisor.ts, FOX_INTERNAL_SECRET). It is how a tool running in a runtime asks
// the gateway for something only the gateway may hold (docs/meta-ads-mcp-plan.md D3): today the Meta Ads calls, made
// with the token of the session's owner. Model-written code (bash, python) runs with an allow-listed environment
// (docker/fox-confine.sh, fox-noconfine.sh) and never has the secret.

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { callForSession, toolsForRuntime } from './ads/meta.ts'
import { config } from './config.ts'
import { errorFields, log } from './log.ts'

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOOL_RE = /^[a-z0-9_]{1,64}$/
const MAX_BODY = 1024 * 1024

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function secretOk(req: IncomingMessage, secret: string): boolean {
  const given = Buffer.from(String(req.headers['x-fox-harness-internal-secret'] ?? ''))
  const want = Buffer.from(secret)
  return given.length === want.length && timingSafeEqual(given, want)
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

export function startInternalServer(secret: string): Server {
  const server = createServer((req, res) => {
    void (async () => {
      if (!secretOk(req, secret)) return send(res, 401, { error: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (req.method === 'GET' && url.pathname === '/internal/meta-ads/tools') {
        return send(res, 200, { tools: await toolsForRuntime() })
      }

      if (req.method === 'POST' && url.pathname === '/internal/meta-ads/call') {
        const body = (await readJson(req).catch(() => undefined)) as
          | { sessionId?: unknown; callId?: unknown; tool?: unknown; arguments?: unknown }
          | undefined
        if (
          !body ||
          typeof body.sessionId !== 'string' || !SESSION_ID_RE.test(body.sessionId) ||
          typeof body.callId !== 'string' || body.callId.length === 0 || body.callId.length > 64 ||
          typeof body.tool !== 'string' || !TOOL_RE.test(body.tool) ||
          (body.arguments !== undefined && (typeof body.arguments !== 'object' || body.arguments === null || Array.isArray(body.arguments)))
        ) {
          return send(res, 400, { error: 'sessionId, callId, tool and an arguments object are required' })
        }
        // the runtime gave up on the call (turn cancelled, tool timeout): stop waiting / calling
        const abort = new AbortController()
        res.on('close', () => {
          if (!res.writableFinished) abort.abort()
        })
        const outcome = await callForSession(body.sessionId, body.callId, body.tool, (body.arguments ?? {}) as Record<string, unknown>, abort.signal)
        return send(res, 200, outcome)
      }

      send(res, 404, { error: 'not found' })
    })().catch((error: unknown) => {
      log('internal_route_failed', { path: req.url, ...errorFields(error) })
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
      else res.end()
    })
  })
  // a write may wait minutes for the user's click (META_ADS_CONFIRM_TIMEOUT_MS): no server-side request timeout here
  server.requestTimeout = 0
  server.headersTimeout = 30_000
  server.listen(config.internalPort, '127.0.0.1', () => log('internal_listening', { port: config.internalPort }))
  return server
}
