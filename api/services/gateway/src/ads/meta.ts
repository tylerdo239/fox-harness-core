// Meta Ads (docs/meta-ads-mcp-plan.md): each user connects their own Meta account (OAuth, PKCE), the gateway keeps
// the token sealed in discovery_ads_connections and is the only client of Meta's ads MCP server. The agent's tools
// (packages/tool/meta-ads) call back here through internal-server.ts with the session and the tool call; this file
// finds the session's owner, checks the tool against ads/tools.ts, holds a write until the owner confirms it, and
// calls Meta with the owner's token. The runtime never sees a token.

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { config } from '../config.ts'
import { dbQuery, getSessionRuntimeInfo } from '../db.ts'
import { errorFields, log } from '../log.ts'
import { checkRateLimit, storeOauthState, takeOauthState } from '../redis.ts'
import { encryptionReady, open, seal } from './crypto.ts'
import { McpHttpClient, McpHttpError, type McpCallResult, type McpTool } from './mcp-client.ts'
import { META_TOOLS, ruleOf, summaryOf, type Tier } from './tools.ts'

const PROVIDER = 'meta'
const meta = config.metaAds

// ---------------------------------------------------------------------------------------------------------------
// connections

interface ConnectionRow {
  user_id: number
  external_user_id: string | null
  external_name: string | null
  scopes: string
  access_token_enc: Buffer
  refresh_token_enc: Buffer | null
  key_id: string
  expires_at: Date | null
  last_error: string | null
  created_at: Date
}

export interface ConnectionStatus {
  provider: 'meta'
  enabled: boolean
  connected: boolean
  name?: string
  scopes?: string[]
  expiresAt?: string
  connectedAt?: string
  /** expired | revoked: the user must connect again */
  problem?: string
}

const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace('T', ' ')
// The driver reads a `datetime` as local time; these columns hold UTC (sqlTime), so take the fields back as UTC —
// right whatever the gateway's own time zone is.
const utcMs = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())

async function connectionRow(userId: number): Promise<ConnectionRow | undefined> {
  const rows = await dbQuery<ConnectionRow[]>(
    `select user_id, external_user_id, external_name, scopes, access_token_enc, refresh_token_enc, key_id, expires_at, last_error, created_at
       from discovery_ads_connections where user_id = ? and provider = ?`,
    [userId, PROVIDER],
  )
  return rows[0]
}

export function metaAdsConfigured(): boolean {
  return meta.enabled && meta.appId !== '' && meta.redirectUrl !== '' && encryptionReady()
}

export async function connectionStatus(userId: number): Promise<ConnectionStatus> {
  if (!meta.enabled) return { provider: 'meta', enabled: false, connected: false }
  const row = await connectionRow(userId)
  if (!row) return { provider: 'meta', enabled: true, connected: false }
  const expired = row.expires_at !== null && utcMs(row.expires_at) <= Date.now() && row.refresh_token_enc === null
  const problem = row.last_error ?? (expired ? 'expired' : undefined)
  return {
    provider: 'meta',
    enabled: true,
    connected: true,
    ...(row.external_name ? { name: row.external_name } : {}),
    scopes: row.scopes.split(' ').filter(Boolean),
    ...(row.expires_at ? { expiresAt: new Date(utcMs(row.expires_at)).toISOString() } : {}),
    connectedAt: row.created_at.toISOString(),
    ...(problem ? { problem } : {}),
  }
}

async function saveConnection(userId: number, token: TokenSet, who: { id?: string; name?: string }): Promise<void> {
  const access = seal(token.accessToken)
  const refresh = token.refreshToken ? seal(token.refreshToken) : undefined
  await dbQuery(
    `insert into discovery_ads_connections
       (user_id, provider, external_user_id, external_name, scopes, access_token_enc, refresh_token_enc, key_id, expires_at, last_error)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, null)
     on duplicate key update external_user_id = values(external_user_id), external_name = values(external_name),
       scopes = values(scopes), access_token_enc = values(access_token_enc), refresh_token_enc = values(refresh_token_enc),
       key_id = values(key_id), expires_at = values(expires_at), last_error = null`,
    [
      userId, PROVIDER, who.id?.slice(0, 64) ?? null, who.name?.slice(0, 255) ?? null, token.scopes.slice(0, 1024),
      access.data, refresh?.data ?? null, access.keyId, token.expiresAt ? sqlTime(token.expiresAt) : null,
    ],
  )
  dropClient(userId)
}

async function markProblem(userId: number, problem: 'expired' | 'revoked'): Promise<void> {
  await dbQuery(`update discovery_ads_connections set last_error = ? where user_id = ? and provider = ?`, [problem, userId, PROVIDER])
  dropClient(userId)
}

/** Settings > Connections > Disconnect: the row goes, and Meta is asked to drop the app's permissions (best effort). */
export async function disconnect(userId: number): Promise<void> {
  const row = await connectionRow(userId)
  if (!row) return
  try {
    const token = open(row.access_token_enc, row.key_id)
    await fetch(`${meta.graphUrl}/me/permissions`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    log('meta_ads_revoke_failed', { userId, ...errorFields(error) })
  }
  await dbQuery(`delete from discovery_ads_connections where user_id = ? and provider = ?`, [userId, PROVIDER])
  dropClient(userId)
  log('meta_ads_disconnected', { userId })
}

/** A deleted user's connection goes with them. */
export async function forgetUser(userId: number): Promise<void> {
  await dbQuery(`delete from discovery_ads_connections where user_id = ?`, [userId])
  dropClient(userId)
}

// ---------------------------------------------------------------------------------------------------------------
// OAuth (authorization code + PKCE S256, as Meta's MCP authorization metadata announces)

interface TokenSet {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scopes: string
}

const STATE_TTL_MS = 10 * 60_000
const base64url = (buf: Buffer) => buf.toString('base64url')

/** The Facebook Login URL the user's browser opens; the state ties the callback to this user. */
export async function startConnect(userId: number): Promise<string> {
  const state = base64url(randomBytes(24))
  const verifier = base64url(randomBytes(48))
  await storeOauthState(state, JSON.stringify({ userId, provider: PROVIDER, verifier }), STATE_TTL_MS)
  const url = new URL(meta.authorizeUrl)
  url.searchParams.set('client_id', meta.appId)
  url.searchParams.set('redirect_uri', meta.redirectUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()))
  url.searchParams.set('code_challenge_method', 'S256')
  if (meta.loginConfigId) url.searchParams.set('config_id', meta.loginConfigId)
  else url.searchParams.set('scope', meta.scopes)
  return url.toString()
}

async function postToken(params: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams({ client_id: meta.appId, ...params })
  if (meta.appSecret) body.set('client_secret', meta.appSecret)
  const response = await fetch(meta.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: unknown
  }
  if (!response.ok || !json.access_token) {
    const reason = typeof json.error === 'object' && json.error ? (json.error as { message?: string }).message : json.error
    throw new Error(`token endpoint ${response.status}: ${String(reason ?? 'no access_token').slice(0, 200)}`)
  }
  return {
    accessToken: json.access_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(typeof json.expires_in === 'number' && json.expires_in > 0 ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
    scopes: json.scope ?? meta.scopes,
  }
}

/**
 * GET /connections/meta/callback?code&state (the browser, back from Facebook). No login token comes with a redirect:
 * the user is the one the single-use state was issued to.
 */
export async function finishConnect(code: string | null, state: string | null, oauthError: string | null): Promise<{ ok: boolean; reason?: string }> {
  if (!state) return { ok: false, reason: 'missing_state' }
  const raw = await takeOauthState(state)
  if (!raw) return { ok: false, reason: 'invalid_state' }
  const saved = JSON.parse(raw) as { userId: number; provider: string; verifier: string }
  if (saved.provider !== PROVIDER) return { ok: false, reason: 'invalid_state' }
  if (oauthError || !code) return { ok: false, reason: oauthError ? 'denied' : 'missing_code' }
  try {
    const token = await postToken({ grant_type: 'authorization_code', code, redirect_uri: meta.redirectUrl, code_verifier: saved.verifier })
    const who = await fetchMe(token.accessToken)
    await saveConnection(saved.userId, token, who)
    log('meta_ads_connected', { userId: saved.userId, expires: token.expiresAt ? sqlTime(token.expiresAt) : null, refresh: !!token.refreshToken })
    void refreshToolsWith(saved.userId).catch(() => undefined)
    return { ok: true }
  } catch (error) {
    log('meta_ads_connect_failed', { userId: saved.userId, ...errorFields(error) })
    return { ok: false, reason: 'exchange_failed' }
  }
}

async function fetchMe(token: string): Promise<{ id?: string; name?: string }> {
  try {
    const response = await fetch(`${meta.graphUrl}/me?fields=id,name`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return {}
    const json = (await response.json()) as { id?: unknown; name?: unknown }
    return { ...(typeof json.id === 'string' ? { id: json.id } : {}), ...(typeof json.name === 'string' ? { name: json.name } : {}) }
  } catch {
    return {}
  }
}

const refreshing = new Map<number, Promise<string | undefined>>()
const REFRESH_AHEAD_MS = 10 * 60_000

/** The user's access token, refreshed first when it ends within ten minutes. undefined = not connected or unusable. */
async function tokenFor(userId: number): Promise<{ token: string } | { problem: 'not_connected' | 'expired' }> {
  const row = await connectionRow(userId)
  if (!row) return { problem: 'not_connected' }
  if (row.last_error) return { problem: 'expired' }
  const expiresAt = row.expires_at ? utcMs(row.expires_at) : undefined
  if (expiresAt === undefined || expiresAt - Date.now() > REFRESH_AHEAD_MS) return { token: open(row.access_token_enc, row.key_id) }
  if (!row.refresh_token_enc) {
    if (expiresAt > Date.now()) return { token: open(row.access_token_enc, row.key_id) }
    await markProblem(userId, 'expired')
    return { problem: 'expired' }
  }
  let pending = refreshing.get(userId)
  if (!pending) {
    pending = (async () => {
      try {
        const token = await postToken({ grant_type: 'refresh_token', refresh_token: open(row.refresh_token_enc!, row.key_id) })
        await saveConnection(userId, { ...token, refreshToken: token.refreshToken ?? open(row.refresh_token_enc!, row.key_id), scopes: token.scopes || row.scopes }, {
          ...(row.external_user_id ? { id: row.external_user_id } : {}),
          ...(row.external_name ? { name: row.external_name } : {}),
        })
        log('meta_ads_token_refreshed', { userId })
        return token.accessToken
      } catch (error) {
        log('meta_ads_refresh_failed', { userId, ...errorFields(error) })
        if (expiresAt <= Date.now()) await markProblem(userId, 'expired')
        return expiresAt > Date.now() ? open(row.access_token_enc, row.key_id) : undefined
      } finally {
        refreshing.delete(userId)
      }
    })()
    refreshing.set(userId, pending)
  }
  const token = await pending
  return token ? { token } : { problem: 'expired' }
}

// ---------------------------------------------------------------------------------------------------------------
// MCP clients, one per user, closed when idle

const IDLE_MS = 10 * 60_000
const clients = new Map<number, { client: McpHttpClient; token: string; usedAt: number }>()

function clientFor(userId: number, token: string): McpHttpClient {
  const held = clients.get(userId)
  if (held && held.token === token) {
    held.usedAt = Date.now()
    return held.client
  }
  if (held) void held.client.close()
  const client = new McpHttpClient(meta.mcpUrl, token, meta.callTimeoutMs)
  clients.set(userId, { client, token, usedAt: Date.now() })
  return client
}

function dropClient(userId: number): void {
  const held = clients.get(userId)
  if (!held) return
  clients.delete(userId)
  void held.client.close()
}

const sweep = setInterval(() => {
  for (const [userId, held] of clients) if (Date.now() - held.usedAt > IDLE_MS) dropClient(userId)
}, 60_000)
sweep.unref()

// ---------------------------------------------------------------------------------------------------------------
// the tool list the runtime registers (packages/tool/meta-ads): Meta's own schemas, fetched with some connected
// user's token (tools/list needs one) and kept on disk, filtered to ads/tools.ts and the enabled tiers

interface CachedTools {
  fetchedAt: number
  tools: McpTool[]
}

const toolsFile = () => join(config.dataDir, 'meta-ads', 'tools.json')
let cached: CachedTools | undefined
let loadedFromDisk = false

async function loadTools(): Promise<CachedTools | undefined> {
  if (!loadedFromDisk) {
    loadedFromDisk = true
    try {
      cached = JSON.parse(await readFile(toolsFile(), 'utf8')) as CachedTools
    } catch {
      // none yet: the first connected user fetches it
    }
  }
  return cached
}

async function refreshToolsWith(userId: number): Promise<void> {
  const access = await tokenFor(userId)
  if (!('token' in access)) return
  const listed = await clientFor(userId, access.token).listTools()
  const tools = listed.filter((tool) => ruleOf(tool.name) !== undefined)
  cached = { fetchedAt: Date.now(), tools }
  await mkdir(join(config.dataDir, 'meta-ads'), { recursive: true })
  await writeFile(`${toolsFile()}.tmp`, JSON.stringify(cached))
  await rename(`${toolsFile()}.tmp`, toolsFile())
  const missing = Object.keys(META_TOOLS).filter((name) => !listed.some((tool) => tool.name === name))
  log('meta_ads_tools_refreshed', { listed: listed.length, kept: tools.length, ...(missing.length > 0 ? { missing } : {}) })
}

/** GET /internal/meta-ads/tools: the schemas of the tools of the enabled tiers ([] until someone has connected). */
export async function toolsForRuntime(): Promise<{ name: string; description: string; inputSchema: unknown; tier: Tier; spends: boolean }[]> {
  if (!meta.enabled) return []
  const list = await loadTools()
  return (list?.tools ?? []).flatMap((tool) => {
    const rule = ruleOf(tool.name)
    if (!rule || !meta.tiers.includes(rule.tier)) return []
    return [{ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? { type: 'object' }, tier: rule.tier, spends: rule.spends === true }]
  })
}

function maybeRefreshTools(userId: number): void {
  if (cached && Date.now() - cached.fetchedAt < meta.toolsRefreshMs) return
  if (cached) cached.fetchedAt = Date.now() // one refresh at a time, not one per call
  void refreshToolsWith(userId).catch((error: unknown) => log('meta_ads_tools_refresh_failed', { userId, ...errorFields(error) }))
}

// ---------------------------------------------------------------------------------------------------------------
// a tool call from the runtime

export type CallOutcome =
  | { ok: true; text: string }
  | { ok: false; code: 'disabled' | 'bad_session' | 'not_allowed' | 'not_connected' | 'expired' | 'rate_limited' | 'too_many_pending' | 'rejected' | 'timeout' | 'meta_error'; message: string }

function resultText(result: McpCallResult): string {
  const parts = (result.content ?? []).map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type}]`))
  let text = parts.join('\n')
  if (!text && result.structuredContent !== undefined) text = JSON.stringify(result.structuredContent)
  if (text.length > meta.resultMaxChars) {
    text = `${text.slice(0, meta.resultMaxChars)}\n\n[truncated: ${String(text.length)} characters — ask for fewer fields, a shorter date range or a filter]`
  }
  return text
}

async function callMeta(userId: number, tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallOutcome> {
  const access = await tokenFor(userId)
  if (!('token' in access)) {
    return access.problem === 'not_connected'
      ? { ok: false, code: 'not_connected', message: 'The user has not connected a Meta account. Ask them to connect it in Settings > Connections.' }
      : { ok: false, code: 'expired', message: 'The Meta connection has expired or was revoked. Ask the user to connect again in Settings > Connections.' }
  }
  const started = Date.now()
  try {
    const result = await clientFor(userId, access.token).callTool(tool, args, signal)
    const text = resultText(result)
    void dbQuery(`update discovery_ads_connections set last_used_at = ? where user_id = ? and provider = ?`, [sqlTime(Date.now()), userId, PROVIDER]).catch(() => undefined)
    log('meta_ads_call', { userId, tool, ms: Date.now() - started, ok: result.isError !== true })
    maybeRefreshTools(userId)
    return result.isError === true ? { ok: false, code: 'meta_error', message: text || 'Meta returned an error.' } : { ok: true, text }
  } catch (error) {
    log('meta_ads_call', { userId, tool, ms: Date.now() - started, ok: false, ...errorFields(error) })
    if (error instanceof McpHttpError && (error.status === 401 || error.status === 403)) {
      if (error.status === 401) await markProblem(userId, 'expired')
      return { ok: false, code: 'expired', message: 'Meta refused the connection (expired or revoked). Ask the user to connect again in Settings > Connections.' }
    }
    if (error instanceof McpHttpError && error.status === 429) return { ok: false, code: 'rate_limited', message: 'Meta is rate limiting this account. Try again in a few minutes.' }
    return { ok: false, code: 'meta_error', message: `Meta ads server error: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` }
  }
}

/** POST /internal/meta-ads/call. `sessionId` is the conversation's root session; its owner's token is used. */
export async function callForSession(
  sessionId: string,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<CallOutcome> {
  if (!meta.enabled) return { ok: false, code: 'disabled', message: 'Meta Ads is not enabled on this server.' }
  const session = await getSessionRuntimeInfo(sessionId)
  if (!session || session.flow !== 'meta-ads') return { ok: false, code: 'bad_session', message: 'This conversation cannot use Meta Ads tools.' }
  const rule = ruleOf(tool)
  if (!rule || !meta.tiers.includes(rule.tier)) return { ok: false, code: 'not_allowed', message: `The tool ${tool} is not allowed here.` }
  if (!(await checkRateLimit('meta-ads', String(session.ownerId), meta.callsPerMinute, 60_000))) {
    return { ok: false, code: 'rate_limited', message: `At most ${String(meta.callsPerMinute)} Meta calls a minute. Wait a moment.` }
  }
  if (rule.tier === 'read') return callMeta(session.ownerId, tool, args, signal)
  return confirmThenCall(session.ownerId, sessionId, callId, tool, args, signal)
}

// ---------------------------------------------------------------------------------------------------------------
// writes wait for the owner's click (docs/meta-ads-mcp-plan.md D7). One gateway process: the waiting request is held
// here; the row in discovery_ads_actions is what the browser reads and what stays as the audit.

const waiters = new Map<string, (decision: 'approved' | 'rejected') => void>()
const waitKey = (sessionId: string, callId: string) => `${sessionId}\n${callId}`

async function setStatus(sessionId: string, callId: string, from: string, to: string, extra: { error?: string; decided?: boolean; finished?: boolean } = {}): Promise<boolean> {
  const now = sqlTime(Date.now())
  const result = await dbQuery<{ affectedRows: number }>(
    `update discovery_ads_actions set status = ?, error = coalesce(?, error)
       ${extra.decided ? ', decided_at = ?' : ''}${extra.finished ? ', finished_at = ?' : ''}
     where session_id = ? and call_id = ? and status = ?`,
    [to, extra.error?.slice(0, 500) ?? null, ...(extra.decided ? [now] : []), ...(extra.finished ? [now] : []), sessionId, callId, from],
  )
  return result.affectedRows > 0
}

async function confirmThenCall(
  userId: number,
  sessionId: string,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<CallOutcome> {
  if (!callId || callId.length > 64) return { ok: false, code: 'bad_session', message: 'missing tool call id' }
  const pendingRows = await dbQuery<{ n: number | bigint }[]>(
    `select count(*) as n from discovery_ads_actions where user_id = ? and status = 'pending'`, [userId])
  if (Number(pendingRows[0]?.n ?? 0) >= meta.maxPendingPerUser) {
    return { ok: false, code: 'too_many_pending', message: 'Too many changes are waiting for confirmation. Ask the user to answer them first.' }
  }
  const { summary, spends, adAccountId } = summaryOf(tool, args)
  const inserted = await dbQuery<{ affectedRows: number }>(
    `insert ignore into discovery_ads_actions (user_id, session_id, call_id, provider, tool, ad_account_id, summary, spends, status, asked_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [userId, sessionId, callId, PROVIDER, tool, adAccountId ?? null, summary, spends ? 1 : 0, sqlTime(Date.now())],
  )
  // a repeated call id (a retry of a request already asked) is never asked or run twice
  if (inserted.affectedRows === 0) return { ok: false, code: 'rejected', message: 'This change was already asked for once.' }
  log('meta_ads_action', { userId, sessionId, callId, tool, status: 'pending', spends })

  const key = waitKey(sessionId, callId)
  const decision = await new Promise<'approved' | 'rejected' | 'expired'>((resolve) => {
    const timer = setTimeout(() => finish('expired'), meta.confirmTimeoutMs)
    const onAbort = () => finish('expired')
    signal?.addEventListener('abort', onAbort, { once: true })
    function finish(value: 'approved' | 'rejected' | 'expired') {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      waiters.delete(key)
      resolve(value)
    }
    waiters.set(key, finish)
  })

  if (decision === 'expired') {
    await setStatus(sessionId, callId, 'pending', 'expired', { finished: true })
    log('meta_ads_action', { userId, sessionId, callId, tool, status: 'expired' })
    return { ok: false, code: 'timeout', message: 'The user did not confirm this change in time; nothing was changed on Meta.' }
  }
  if (decision === 'rejected') {
    log('meta_ads_action', { userId, sessionId, callId, tool, status: 'rejected' })
    return { ok: false, code: 'rejected', message: 'The user declined this change; nothing was changed on Meta. Do not retry it unless they ask.' }
  }
  const outcome = await callMeta(userId, tool, args, signal)
  await setStatus(sessionId, callId, 'approved', outcome.ok ? 'done' : 'error', { finished: true, ...(outcome.ok ? {} : { error: outcome.message }) })
  log('meta_ads_action', { userId, sessionId, callId, tool, status: outcome.ok ? 'done' : 'error' })
  return outcome
}

/** POST /meta-ads/actions/decision — only the session's owner decides (the caller checked access to the session). */
export async function decide(userId: number, sessionId: string, callId: string, decision: 'approve' | 'reject'): Promise<'ok' | 'not_pending' | 'forbidden'> {
  const rows = await dbQuery<{ user_id: number; status: string }[]>(
    `select user_id, status from discovery_ads_actions where session_id = ? and call_id = ?`, [sessionId, callId])
  const row = rows[0]
  if (!row || row.status !== 'pending') return 'not_pending'
  if (row.user_id !== userId) return 'forbidden'
  const waiter = waiters.get(waitKey(sessionId, callId))
  if (!waiter) {
    // the request that asked is gone (gateway restarted, the turn was cancelled): nothing may run any more
    await setStatus(sessionId, callId, 'pending', 'expired', { finished: true })
    return 'not_pending'
  }
  const to = decision === 'approve' ? 'approved' : 'rejected'
  if (!(await setStatus(sessionId, callId, 'pending', to, { decided: true, ...(to === 'rejected' ? { finished: true } : {}) }))) return 'not_pending'
  waiter(to)
  return 'ok'
}

export interface ActionView {
  callId: string
  tool: string
  summary: string
  spends: boolean
  status: string
  error?: string
  askedAt: string
  expiresAt: string
}

/** GET /meta-ads/actions?sessionId= — the cards of one conversation. */
export async function listActions(sessionId: string): Promise<ActionView[]> {
  const rows = await dbQuery<{ call_id: string; tool: string; summary: string; spends: number; status: string; error: string | null; asked_at: Date }[]>(
    `select call_id, tool, summary, spends, status, error, asked_at from discovery_ads_actions where session_id = ? order by id`, [sessionId])
  return rows.map((row) => ({
    callId: row.call_id,
    tool: row.tool,
    summary: row.summary,
    spends: row.spends === 1,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    askedAt: new Date(utcMs(row.asked_at)).toISOString(),
    expiresAt: new Date(utcMs(row.asked_at) + meta.confirmTimeoutMs).toISOString(),
  }))
}

/** At start-up: a write still pending belongs to a request that died with the previous process. */
export async function expireStalePending(): Promise<void> {
  if (!meta.enabled) return
  try {
    const result = await dbQuery<{ affectedRows: number }>(
      `update discovery_ads_actions set status = 'expired', finished_at = ? where status = 'pending'`, [sqlTime(Date.now())])
    if (result.affectedRows > 0) log('meta_ads_actions_expired', { count: result.affectedRows })
  } catch (error) {
    log('meta_ads_tables_missing', errorFields(error)) // 004_ads.sql not run yet
  }
}
