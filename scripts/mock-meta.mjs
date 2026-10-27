#!/usr/bin/env node
// A fake Meta for scripts/e2e-backend.mjs (metaAds test, docs/meta-ads-mcp-plan.md): Facebook Login (authorize +
// token, PKCE checked), the Graph calls the gateway makes (/me, DELETE /me/permissions) and the ads MCP server
// (Streamable HTTP: JSON replies, and an SSE reply for tools/call to exercise that path).
//
//   node scripts/mock-meta.mjs [port]      (default 4998)
//
// Test hooks: GET /_calls (every tools/call, token exchange and revoke), DELETE /_calls, POST /_config
// {expiresIn, refresh} for the next tokens issued.

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? process.env.MOCK_META_PORT ?? 4998)
const codes = new Map() // code -> { challenge, redirectUri, clientId }
const tokens = new Map() // access token -> { user, revoked }
const refreshTokens = new Map() // refresh token -> user
const sessions = new Set()
let calls = []
let settings = { expiresIn: 3600, refresh: false }
let userSeq = 0

const TOOLS = [
  { name: 'ads_get_ad_accounts', description: 'List the ad accounts you can access.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'ads_get_ad_entities',
    description: 'Search campaigns, ad sets and ads with metrics.',
    inputSchema: { type: 'object', properties: { ad_account_id: { type: 'string' }, date_preset: { type: 'string' } }, required: ['ad_account_id'] },
  },
  {
    name: 'ads_create_campaign',
    description: 'Create a campaign (paused).',
    inputSchema: { type: 'object', properties: { ad_account_id: { type: 'string' }, name: { type: 'string' }, objective: { type: 'string' }, daily_budget: { type: 'number' } }, required: ['ad_account_id', 'name'] },
  },
  { name: 'ads_activate_entity', description: 'Activate a paused entity.', inputSchema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] } },
  // not in the gateway's allow-list: must never be offered to the model nor reach here
  { name: 'ads_delete_custom_audience', description: 'Delete a custom audience.', inputSchema: { type: 'object', properties: { audience_id: { type: 'string' } } } },
]

const read = (req) => new Promise((resolve) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
})
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
const bearer = (req) => {
  const h = String(req.headers.authorization ?? '')
  return h.startsWith('Bearer ') ? h.slice(7) : undefined
}
const live = (token) => token !== undefined && tokens.has(token) && !tokens.get(token).revoked

function issue(user) {
  const access = `tok-${randomBytes(8).toString('hex')}`
  tokens.set(access, { user, revoked: false })
  const body = { access_token: access, token_type: 'bearer', expires_in: settings.expiresIn }
  if (settings.refresh) {
    const refresh = `ref-${randomBytes(8).toString('hex')}`
    refreshTokens.set(refresh, user)
    body.refresh_token = refresh
  }
  return body
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')

  if (url.pathname === '/_calls' && req.method === 'GET') return json(res, 200, calls)
  if (url.pathname === '/_calls' && req.method === 'DELETE') { calls = []; return json(res, 200, {}) }
  if (url.pathname === '/_config' && req.method === 'POST') { settings = { ...settings, ...JSON.parse(await read(req)) }; return json(res, 200, settings) }

  // Facebook Login: answers at once as if the user approved (or with ?error when the test asks for a refusal)
  if (url.pathname === '/oauth/authorize') {
    const redirect = new URL(url.searchParams.get('redirect_uri'))
    redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
    if (url.searchParams.get('code_challenge_method') !== 'S256') redirect.searchParams.set('error', 'pkce_required')
    else {
      const code = `code-${randomBytes(6).toString('hex')}`
      codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirectUri: url.searchParams.get('redirect_uri'), clientId: url.searchParams.get('client_id') })
      redirect.searchParams.set('code', code)
    }
    res.writeHead(302, { location: redirect.toString() })
    return res.end()
  }

  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(await read(req))
    calls.push({ kind: 'token', grant: form.get('grant_type') })
    if (form.get('grant_type') === 'authorization_code') {
      const saved = codes.get(form.get('code'))
      codes.delete(form.get('code'))
      const verifier = form.get('code_verifier') ?? ''
      if (!saved || saved.redirectUri !== form.get('redirect_uri') || saved.clientId !== form.get('client_id') ||
        createHash('sha256').update(verifier).digest('base64url') !== saved.challenge) {
        return json(res, 400, { error: { message: 'invalid code or verifier' } })
      }
      userSeq += 1
      return json(res, 200, issue(`user-${userSeq}`))
    }
    if (form.get('grant_type') === 'refresh_token') {
      const user = refreshTokens.get(form.get('refresh_token'))
      if (!user) return json(res, 400, { error: { message: 'invalid refresh token' } })
      return json(res, 200, issue(user))
    }
    return json(res, 400, { error: { message: 'unsupported grant' } })
  }

  if (url.pathname === '/graph/me' && req.method === 'GET') {
    const token = bearer(req)
    if (!live(token)) return json(res, 401, { error: { message: 'invalid token' } })
    return json(res, 200, { id: `fb-${tokens.get(token).user}`, name: 'E2E Meta User' })
  }
  if (url.pathname === '/graph/me/permissions' && req.method === 'DELETE') {
    const token = bearer(req)
    calls.push({ kind: 'revoke', token })
    if (live(token)) tokens.get(token).revoked = true
    return json(res, 200, { success: true })
  }

  if (url.pathname === '/mcp') {
    const token = bearer(req)
    if (!live(token)) {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://x/.well-known/oauth-protected-resource/mcp"' })
      return res.end('unauthorized')
    }
    if (req.method === 'DELETE') { sessions.delete(String(req.headers['mcp-session-id'])); res.writeHead(200); return res.end() }
    const message = JSON.parse(await read(req))
    if (message.method === 'initialize') {
      const session = randomBytes(8).toString('hex')
      sessions.add(session)
      return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-meta-ads', version: '1' } } }, { 'mcp-session-id': session })
    }
    if (!sessions.has(String(req.headers['mcp-session-id']))) return json(res, 404, { error: 'unknown session' })
    if (message.id === undefined) { res.writeHead(202); return res.end() }
    if (message.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params
      calls.push({ kind: 'call', tool: name, args, user: tokens.get(token).user, token })
      const text = name === 'ads_get_ad_accounts'
        ? `accounts of ${tokens.get(token).user}: act_1 (VND)`
        : name === 'ads_create_campaign' ? `created campaign 120001 "${args?.name}" PAUSED` : `${name} ok`
      // SSE reply, with a notification first that the client must skip
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working' } })}\n\n`)
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } })}\n\n`)
      return res.end()
    }
    return json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
  }

  json(res, 404, { error: 'not found' })
}).listen(port, process.env.MOCK_BIND ?? '127.0.0.1', () => console.log(`mock meta on :${port}`))
