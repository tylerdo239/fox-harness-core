#!/usr/bin/env node
// End-to-end test of the two-service deployment (docs/single-backend-architecture-plan.md): a real browser-facing
// path — nginx (web image) -> gateway -> the agent runtime(s) it started -> mock LLM — with two real users.
// Everything is driven over HTTP/WebSocket exactly as app/ (the web UI) does; the only inspection of the backend's
// insides is `docker exec` (planting a canary file in another user's workspace, reading logs).
//
//   scripts/e2e-up.sh        # builds nothing: needs fox-harness-backend:dev and fox-harness-web:dev
//   node scripts/e2e-backend.mjs [testName...]
//   scripts/e2e-down.sh
//
// Env: E2E_URL (default http://127.0.0.1:18080), E2E_BACKEND (container, default foxe2e-backend),
//      E2E_MOCK (mock LLM base, default http://127.0.0.1:4999).

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

const BASE = process.env.E2E_URL ?? 'http://127.0.0.1:18080'
const WS_BASE = BASE.replace(/^http/, 'ws')
const BACKEND = process.env.E2E_BACKEND ?? 'foxe2e-backend'
const MOCK = process.env.E2E_MOCK ?? 'http://127.0.0.1:4999'
// scripts/e2e-up.sh: the backend's FOX_SANDBOX_MODE (strict = bubblewrap isolation; none = no isolation, by design)
const SANDBOX_MODE = process.env.E2E_SANDBOX_MODE ?? 'strict'
const skippedWithoutSandbox = { ok: true, detail: 'skipped: FOX_SANDBOX_MODE=none runs model code without isolation, by design' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dx = (...args) => execFileSync('docker', ['exec', BACKEND, ...args], { encoding: 'utf8' })
// The login API does not return the user id (by design), so a session's real workspace is found on disk.
const workspaceOf = (sessionId) => dx('sh', '-c', `ls -d /data/users/*/${sessionId}`).trim()

async function api(method, path, token, body, raw = false) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

// Self-registration is gone: accounts are created by an admin (scripts/e2e-up.sh bootstraps one).
const ADMIN = { email: 'admin@e2e.test', password: 'admin-e2e-password' }
let adminToken
async function admin() {
  if (!adminToken) adminToken = (await api('POST', '/auth/login', undefined, ADMIN)).json?.token
  if (!adminToken) throw new Error('admin login failed — did scripts/e2e-up.sh create the admin?')
  return adminToken
}

async function newUser(label, role = 'user') {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.test`
  const password = 'correct-horse-battery'
  const reg = await api('POST', '/users', await admin(), { email, password, role })
  if (reg.status !== 201) throw new Error(`create user failed: ${reg.status} ${reg.text}`)
  const login = await api('POST', '/auth/login', undefined, { email, password })
  return { email, password, token: login.json.token, id: reg.json.id, role: login.json.role }
}

/** A single-use WebSocket ticket for this login (POST /auth/ws-ticket); undefined when the token is refused. */
async function wsTicket(token) {
  const r = await api('POST', '/auth/ws-ticket', token)
  return r.status === 200 ? r.json.ticket : undefined
}

/** One chat connection through the full path. `events` = snapshot + live events. Opens with a ws ticket, as the app does. */
function chat(token, { session = 'new', params = {}, ticket } = {}) {
  const c = { ws: undefined, events: [], frames: [], errors: [], closed: false, status: undefined, sessionId: session === 'new' ? undefined : session }
  const waiters = []
  const notify = () => { for (const w of [...waiters]) w() }
  let wsReady
  const wsPromise = new Promise((resolve) => { wsReady = resolve })
  void (ticket !== undefined ? Promise.resolve(ticket) : wsTicket(token)).then((t) => {
    const query = new URLSearchParams({ ticket: t ?? 'none', ...params })
    const ws = new WebSocket(`${WS_BASE}/sessions/${session}?${query}`)
    c.ws = ws
    wire(ws)
    wsReady(ws)
  })
  function wire(ws) {
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    c.frames.push(frame)
    if (frame.type === 'session') c.sessionId = frame.sessionId
    if (frame.type === 'snapshot') c.events.push(...frame.events)
    else if (frame.type === 'event') c.events.push(frame.event)
    else if (frame.type === 'error') c.errors.push(frame.message)
    notify()
  })
  ws.on('unexpected-response', (_req, res) => { c.status = res.statusCode; c.closed = true; notify() })
  ws.on('close', () => { c.closed = true; notify() })
  ws.on('error', () => notify())
  }
  c.opened = wsPromise.then((ws) => new Promise((resolve) => { ws.once('open', () => resolve(true)); ws.once('error', () => resolve(false)); ws.once('unexpected-response', () => resolve(false)) }))
  c.send = (text) => c.ws.send(JSON.stringify({ type: 'followup', text }))
  c.waitFor = (predicate, timeoutMs = 30000, label = 'condition') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${label}; errors=${JSON.stringify(c.errors)} status=${c.status}`)) }, timeoutMs)
    const check = () => { const hit = predicate(c); if (hit) { cleanup(); resolve(hit) } }
    const cleanup = () => { clearTimeout(timer); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1) }
    waiters.push(check); check()
  })
  c.ready = () => c.waitFor((x) => x.frames.some((f) => f.type === 'snapshot'), 30000, 'snapshot')
  c.turnEnds = (n, ms) => c.waitFor((x) => x.events.filter((e) => e.type === 'turn/end').length >= n, ms, `${n} turn/end`)
  c.close = () => { void wsPromise.then((ws) => { try { ws.close() } catch { /* already closed */ } }) }
  return c
}

const mock = async () => (await fetch(`${MOCK}/_requests`)).json()
const clearMock = () => fetch(`${MOCK}/_requests`, { method: 'DELETE' })
// Text of the LAST tool result in the log (the chunk events that follow it must not hide it).
const toolText = (events) => {
  const results = events.filter((e) => e.type === 'tool/result')
  return JSON.stringify(results.length ? results[results.length - 1].data.message?.content : null)
}
const lastText = (events) => {
  const m = [...events].reverse().find((e) => e.type === 'assistant/message')
  return (m?.data?.message?.content ?? []).map((b) => b.text ?? '').join('')
}
const turnsOf = (events) => events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)

async function waitReady(ms = 120000) {
  const end = Date.now() + ms
  for (;;) {
    const r = await fetch(`${BASE}/readyz`).then((x) => x.json().then((j) => ({ s: x.status, j }))).catch(() => undefined)
    if (r?.s === 200) return r.j
    if (Date.now() > end) throw new Error('backend never became ready')
    await sleep(1000)
  }
}

// What the session archive (docs/session-archive-plan.md) holds in MinIO, read with the backend's own S3 client.
const s3 = (op, prefix) => JSON.parse(dx('node', '-e', `
const { createRequire } = require('node:module')
const s3 = createRequire('/repo/services/gateway/package.json')('@aws-sdk/client-s3')
const c = new s3.S3Client({ endpoint: process.env.S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } })
const run = ${JSON.stringify(op)} === 'versions'
  ? c.send(new s3.ListObjectVersionsCommand({ Bucket: process.env.S3_BUCKET, Prefix: ${JSON.stringify(prefix ?? '')} })).then((r) => [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].map((v) => v.Key))
  : c.send(new s3.GetBucketLifecycleConfigurationCommand({ Bucket: process.env.S3_BUCKET })).then((r) => r.Rules ?? [], () => [])
run.then((x) => console.log(JSON.stringify(x)))`))

// ---- shared fixtures (created once) ----
const world = {}
async function users() {
  if (!world.a) { world.a = await newUser('alice'); world.b = await newUser('bob') }
  return world
}

const tests = {
  async health() {
    const ready = await waitReady()
    const index = await fetch(`${BASE}/`)
    const spa = await fetch(`${BASE}/chat/${randomUUID()}`)
    return { ok: ready.ok && ready.shards.length >= 1 && index.status === 200 && (await index.text()).includes('<div id') && spa.status === 200, detail: `readyz shards=${JSON.stringify(ready.shards.map((s) => s.up))}, SPA index+/chat/<id> served by nginx` }
  },

  async chatAndList() {
    const { a } = await users()
    const c = chat(a.token, { params: { flow: 'default' } })
    if (!(await c.opened)) return { ok: false, detail: `ws refused: ${c.status}` }
    await c.ready(); c.send('hello alice'); await c.turnEnds(1)
    const sessionId = c.sessionId
    world.aliceSession = sessionId
    await sleep(300)
    const mine = await api('GET', '/sessions/mine', a.token)
    const row = mine.json?.find((r) => r.sessionId === sessionId)
    c.close()
    return { ok: lastText(c.events) === 'OK' && !!row, detail: `reply=${lastText(c.events)} listed=${!!row} status=${row?.status}` }
  },

  async flowsDiffer() {
    const { a, b } = await users()
    await clearMock()
    const ca = chat(a.token, { params: { flow: 'default' } }); const cb = chat(b.token, { params: { flow: 'data-studio' } })
    await Promise.all([ca.opened, cb.opened]); await Promise.all([ca.ready(), cb.ready()])
    ca.send('MARK-FA hi'); cb.send('MARK-FB hi'); await Promise.all([ca.turnEnds(1), cb.turnEnds(1)])
    world.bobSession = cb.sessionId
    const reqs = await mock()
    const ra = reqs.find((r) => r.lastUser.startsWith('MARK-FA')), rb = reqs.find((r) => r.lastUser.startsWith('MARK-FB'))
    ca.close(); cb.close()
    return { ok: !!ra && !!rb && rb.tools.length === 1 && rb.tools[0] === 'analyze_data' && ra.tools.length > 5 && !ra.tools.includes('analyze_data') && !ra.tools.includes('read_image') && ra.tools.includes('read') && rb.system.includes('Data Studio'), detail: `default analyze_data=${ra?.tools.includes('analyze_data')} read_image=${ra?.tools.includes('read_image')} default tools=${ra?.tools.length}, data-studio tools=${JSON.stringify(rb?.tools)}` }
  },

  async ownership() {
    const { a, b } = await users()
    const intruder = chat(b.token, { session: world.aliceSession })
    await intruder.opened.catch(() => {})
    await sleep(500)
    const del = await api('DELETE', `/sessions/${world.aliceSession}`, b.token)
    const files = await api('GET', `/sessions/${world.aliceSession}/files`, b.token)
    const anon = chat('not-a-token')
    await anon.opened; await sleep(300)
    return { ok: intruder.status === 403 && del.status === 403 && files.status === 404 && anon.status === 401, detail: `B->A ws=${intruder.status} delete=${del.status} files=${files.status}; bad token ws=${anon.status}` }
  },

  async crossUserIsolation() {
    if (SANDBOX_MODE === 'none') return skippedWithoutSandbox
    const { a, b } = await users()
    // B's workspace on disk, with a canary; A's agent is then asked to reach it through every route.
    const sb = world.bobSession
    const bDir = workspaceOf(sb) // B's REAL workspace
    const bId = bDir.split('/')[3]
    dx('sh', '-c', `mkdir -p ${bDir} && echo SECRET-B-CANARY > ${bDir}/secret.txt`)
    dx('sh', '-c', `echo HOSTFILE-CANARY > /data/canary-outside.txt`)
    const ca = chat(a.token, { params: { flow: 'default' } })
    await ca.opened; await ca.ready()
    const vectors = [
      ['read other user abs', 'read', { file_path: `${bDir}/secret.txt` }, 'SECRET-B-CANARY'],
      ['read ../ traversal', 'read', { file_path: `../../${bId}/${sb}/secret.txt` }, 'SECRET-B-CANARY'],
      ['grep data root', 'grep', { pattern: 'SECRET-B', path: '/data', output_mode: 'content' }, 'SECRET-B-CANARY'],
      ['bash cat other user', 'bash', { command: `cat ${bDir}/secret.txt`, description: 'cat' }, 'SECRET-B-CANARY'],
      ['bash cat host file', 'bash', { command: 'cat /data/canary-outside.txt', description: 'cat' }, 'HOSTFILE-CANARY'],
      // each entry printed as USERDIR:<name>:END so a short id like `2` cannot match digits elsewhere in the result
      ['bash list users dir', 'bash', { command: "ls /data/users | sed 's/.*/USERDIR:&:END/'", description: 'ls' }, `USERDIR:${bId}:END`],
      ['bash /proc/1/environ', 'bash', { command: "cat /proc/1/environ | tr '\\0' '\\n'", description: 'p' }, 'DATABASE_URL'],
      ['bash env', 'bash', { command: 'env', description: 'env' }, 'S3_SECRET'],
    ]
    const rows = []
    let n = 0
    for (const [label, tool, args, marker] of vectors) {
      ca.send(`CALL ${tool} ${JSON.stringify(args)}`); n += 1
      await ca.turnEnds(n, 40000).catch(() => {})
      const text = toolText(ca.events)
      rows.push([label, !text.includes(marker)])
    }
    // control: the user's own workspace still works
    ca.send(`CALL bash ${JSON.stringify({ command: 'echo OWN-OK > f.txt && cat f.txt', description: 'own' })}`); n += 1
    await ca.turnEnds(n, 40000).catch(() => {})
    const control = toolText(ca.events).includes('OWN-OK')
    ca.close()
    const leaks = rows.filter(([, ok]) => !ok).map(([l]) => l)
    return { ok: leaks.length === 0 && control, detail: `${rows.length} vectors, leaks=${JSON.stringify(leaks)}, own-workspace control=${control}` }
  },

  // A subagent has its own scope (joined to the parent's preset, not the parent's agent scope), so a guard on
  // the parent's scope did not cover it: measured, a subagent's `read` returned another user's file. The child
  // runs in the background, so what its tool returned is read from the mock LLM's record of the child's request.
  async subagentIsolation() {
    if (SANDBOX_MODE === 'none') return skippedWithoutSandbox
    const { a, b } = await users()
    const bDir = workspaceOf(world.bobSession)
    dx('sh', '-c', `echo SECRET-B-CANARY > ${bDir}/secret.txt`)
    await clearMock()
    const ca = chat(a.token, { params: { flow: 'default' } }); await ca.opened; await ca.ready()
    const probes = [`${bDir}/secret.txt`, '/proc/self/environ']
    let n = 0
    for (const path of probes) {
      ca.send(`CALL subagent ${JSON.stringify({ description: 'probe', prompt: `CALL read ${JSON.stringify({ file_path: path })}` })}`); n += 1
      await ca.turnEnds(n, 60000).catch(() => {})
    }
    await sleep(8000) // the children finish in the background
    const seen = (await mock()).map((r) => r.lastTool ?? '').filter(Boolean)
    const childSawRead = seen.filter((t) => t.includes('workspace guard') || t.includes('<content>'))
    const leaked = seen.some((t) => t.includes('SECRET-B-CANARY') || t.includes('OPENAI_API_KEY') || t.includes('FOX_INTERNAL_SECRET'))
    ca.close()
    return { ok: childSawRead.length >= 2 && !leaked, detail: `child read results=${childSawRead.length} (must be refused), leaked=${leaked}: ${childSawRead.map((t) => t.slice(0, 70)).join(' | ')}` }
  },

  async pythonAndFiles() {
    const { a, b } = await users()
    const ca = chat(a.token, { params: { flow: 'data-analysis' } }); const cb = chat(b.token, { params: { flow: 'data-analysis' } })
    await Promise.all([ca.opened, cb.opened]); await Promise.all([ca.ready(), cb.ready()])
    const py = async (c, code, n) => { c.send(`CALL python ${JSON.stringify({ code })}`); await c.turnEnds(n, 90000); return toolText(c.events) }
    await py(ca, 'x = 41', 1)
    const rb = await py(cb, 'print(x)', 1)
    const ra = await py(ca, 'print(x + 1)', 2)
    // upload a data file, list it, download it; the other user cannot see it
    const csv = 'a,b\n1,2\n3,4\n'
    const up = await api('POST', `/sessions/${ca.sessionId}/files?name=data.csv`, a.token, csv, true)
    const list = await api('GET', `/sessions/${ca.sessionId}/files`, a.token)
    const dl = await api('GET', `/sessions/${ca.sessionId}/files/data.csv`, a.token)
    const other = await api('GET', `/sessions/${ca.sessionId}/files/data.csv`, b.token)
    const bad = await api('POST', `/sessions/${ca.sessionId}/files?name=${encodeURIComponent('../evil.txt')}`, a.token, 'x', true)
    const trav = await api('GET', `/sessions/${ca.sessionId}/files/..%2F..%2Fsecret`, a.token)
    ca.close(); cb.close()
    const checks = {
      'B cannot see A python variable': rb.includes('NameError') || rb.includes('not defined'),
      'A keeps its variable': ra.includes('42'),
      'upload 201': up.status === 201,
      'listed': list.json?.files?.some((f) => f.path === 'data.csv'),
      'download body': dl.text === csv,
      'other user 404': other.status === 404,
      'bad file name 400': bad.status === 400,
      'path traversal not served': trav.status === 404,
    }
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
    world.analysisSession = { id: undefined }
    return { ok: failed.length === 0, detail: failed.length ? `FAILED: ${failed.join('; ')} | B said: ${rb.slice(0, 200)} | A said: ${ra.slice(0, 200)}` : `${Object.keys(checks).length} checks` }
  },

  async skillsPerUser() {
    const { a, b } = await users()
    const name = `e2e-skill-${Math.floor(Math.random() * 1e6)}`
    const created = await api('POST', '/custom-skills', a.token, { name, description: 'e2e skill', content: 'Do the e2e thing.' })
    await clearMock()
    const ca = chat(a.token, { params: { flow: 'default' } }); const cb = chat(b.token, { params: { flow: 'default' } })
    await Promise.all([ca.opened, cb.opened]); await Promise.all([ca.ready(), cb.ready()])
    ca.send('MARK-SA hi'); cb.send('MARK-SB hi'); await Promise.all([ca.turnEnds(1), cb.turnEnds(1)])
    const reqs = await mock(); ca.close(); cb.close()
    const ra = reqs.find((r) => r.lastUser.startsWith('MARK-SA')), rb = reqs.find((r) => r.lastUser.startsWith('MARK-SB'))
    const del = await api('DELETE', `/custom-skills/${name}`, a.token)
    return { ok: created.status === 201 && ra?.skills.includes(name) && !rb?.skills.includes(name) && del.status === 204 && ra.skills.length > 1, detail: `create=${created.status} A sees it=${ra?.skills.includes(name)} B sees it=${rb?.skills.includes(name)} built-ins kept=${ra?.skills.length - 1}` }
  },

  async modelsAndValidation() {
    const { a } = await users()
    const models = await api('GET', '/models')
    const bad = chat(a.token, { params: { model: 'not-allowed-model' } }); await bad.opened; await sleep(300)
    const flow = chat(a.token, { params: { flow: 'nope' } }); await flow.opened; await sleep(300)
    const proj = chat(a.token, { params: { project: randomUUID() } }); await proj.opened; await sleep(300)
    return { ok: models.json?.models?.length >= 1 && bad.status === 400 && flow.status === 400 && proj.status === 403, detail: `models=${JSON.stringify(models.json?.models)} badModel=${bad.status} badFlow=${flow.status} foreignProject=${proj.status}` }
  },

  async idleDisposeAndResume() {
    const { a } = await users()
    const c = chat(a.token, { params: { flow: 'default' } }); await c.opened; await c.ready()
    c.send('idle test'); await c.turnEnds(1)
    const id = c.sessionId; c.close()
    const before = (execFileSync('docker', ['logs', BACKEND], { encoding: 'utf8' }).match(/session_disposed_idle/g) ?? []).length
    await sleep(15000) // FOX_IDLE_DISPOSE_MS=8000 in e2e-up.sh
    const after = (execFileSync('docker', ['logs', BACKEND], { encoding: 'utf8' }).match(/session_disposed_idle/g) ?? []).length
    const again = chat(a.token, { session: id }); await again.opened; await again.ready()
    again.send('after idle'); await again.turnEnds(2)
    again.close()
    return { ok: after > before && JSON.stringify(turnsOf(again.events)) === '[1,2]', detail: `disposed events ${before}->${after}; resumed turns=${JSON.stringify(turnsOf(again.events))}` }
  },

  async restartResumes() {
    const { a, b } = await users()
    const ca = chat(a.token, { params: { flow: 'default' } }); const cb = chat(b.token, { params: { flow: 'data-studio' } })
    await Promise.all([ca.opened, cb.opened]); await Promise.all([ca.ready(), cb.ready()])
    ca.send('before restart A'); cb.send('before restart B'); await Promise.all([ca.turnEnds(1), cb.turnEnds(1)])
    await sleep(500)
    const ia = ca.sessionId, ib = cb.sessionId; ca.close(); cb.close()
    execFileSync('docker', ['restart', '-t', '30', BACKEND], { stdio: 'ignore' })
    await waitReady()
    await clearMock()
    const a2 = chat(a.token, { session: ia }); const b2 = chat(b.token, { session: ib })
    await Promise.all([a2.opened, b2.opened]); await Promise.all([a2.ready(), b2.ready()])
    const replayed = lastText(a2.events) === 'OK' && turnsOf(a2.events).length === 1
    a2.send('MARK-RA after'); b2.send('MARK-RB after')
    await Promise.all([a2.turnEnds(2), b2.turnEnds(2)])
    const reqs = await mock()
    const rb = reqs.find((r) => r.lastUser.startsWith('MARK-RB'))
    a2.close(); b2.close()
    return { ok: replayed && JSON.stringify(turnsOf(a2.events)) === '[1,2]' && rb?.tools.length === 1 && rb.tools[0] === 'analyze_data', detail: `history replayed=${replayed}; turns=${JSON.stringify(turnsOf(a2.events))}; data-studio flow re-joined tools=${JSON.stringify(rb?.tools)}` }
  },

  async gracefulStopMidTurn() {
    const { a } = await users()
    const c = chat(a.token, { params: { flow: 'default' } }); await c.opened; await c.ready()
    c.send('first, completed turn'); await c.turnEnds(1)
    c.send('SLOW stream please')
    await c.waitFor((x) => x.events.filter((e) => e.type === 'assistant/chunk').length >= 8, 30000, 'chunks of the 2nd turn')
    const id = c.sessionId; c.close()
    execFileSync('docker', ['stop', '-t', '40', BACKEND], { stdio: 'ignore' }) // SIGTERM: the gateway asks each runtime to flush
    execFileSync('docker', ['start', BACKEND], { stdio: 'ignore' })
    await waitReady()
    const again = chat(a.token, { session: id }); await again.opened; await again.ready()
    const ends = again.events.filter((e) => e.type === 'turn/end').map((e) => e.data.reason.kind)
    const firstKept = lastText(again.events.filter((e) => e.type !== 'assistant/chunk')) !== ''
    again.send('after the stop'); await again.turnEnds(3, 40000)
    again.close()
    return { ok: ends[0] === 'completed' && ends.length === 2 && ends[1] !== 'completed' && JSON.stringify(turnsOf(again.events)) === '[1,2,3]' && firstKept, detail: `turn ends after restart=${JSON.stringify(ends)} (completed turn kept, interrupted one closed), next turns=${JSON.stringify(turnsOf(again.events))}` }
  },

  // Two roles. user: chats + own data + own Data Studio dashboards/charts. admin: everything (src/index.ts adminGate).
  async roleGate() {
    const { a } = await users()
    const adm = await admin()
    const rows = []
    const expect = async (label, token, method, path, body, want) => {
      const r = await api(method, path, token, body)
      rows.push([label, r.status, want])
    }
    // no self-registration
    await expect('register, anonymous', undefined, 'POST', '/auth/register', { email: `x${Date.now()}@e2e.test`, password: 'xxxxxxxxxx' }, 401)
    await expect('register, as user', a.token, 'POST', '/auth/register', { email: `y${Date.now()}@e2e.test`, password: 'xxxxxxxxxx' }, 403)
    await expect('create user, as user', a.token, 'POST', '/users', { email: `z${Date.now()}@e2e.test`, password: 'xxxxxxxxxx' }, 403)
    await expect('list users, as user', a.token, 'GET', '/users', undefined, 403)
    await expect('change a role, as user', a.token, 'PATCH', `/users/${a.id}`, { role: 'admin' }, 403)
    // Data Studio: admin-only except the per-user dashboards and charts (dashboardOwnership covers those)
    for (const [method, path, body] of [
      ['GET', '/data-studio/sources'], ['PATCH', '/data-studio/sources/x', {}], ['GET', '/data-studio/glossary'],
      ['POST', '/data-studio/glossary', {}], ['GET', '/data-studio/metrics'], ['GET', '/data-studio/relationships'],
      ['POST', '/data-studio/dremio/sync', {}], ['POST', '/data-studio/dremio/browse', {}], ['PATCH', '/data-studio/entities/x', { allow_user: true }],
      // Data Studio v4 phase 2: delete source, per-dataset import
      ['DELETE', '/data-studio/sources/x'], ['GET', '/data-studio/dremio/sources/x/datasets'],
      ['POST', '/data-studio/dremio/sync', { datasets: [['x', 'y']] }],
      // phase 3: the data profile (reference routes in the Python admin worker)
      ['GET', '/data-studio/profile/metrics'], ['PUT', '/data-studio/profile/entities/x', {}],
      ['GET', '/data-studio/profile/data-sources/x/export.docx'], ['POST', '/data-studio/profile/metrics/run', { draft: {} }],
    ]) await expect(`${method} ${path}, as user`, a.token, method, path, body, 403)
    const dashUser = await api('GET', '/data-studio/dashboards', a.token)
    rows.push(['GET dashboards, as user (own dashboards)', dashUser.status === 403 ? 403 : 'not 403', 'not 403'])
    const srcAdmin = await api('GET', '/data-studio/sources', adm)
    rows.push(['GET sources, as admin', srcAdmin.status === 403 || srcAdmin.status === 401 ? srcAdmin.status : 'allowed', 'allowed'])
    // an admin cannot demote themselves
    const list = await api('GET', '/users', adm)
    const me = Array.isArray(list.json) ? list.json.find((u) => u.email === ADMIN.email) : undefined
    if (!me) return { ok: false, detail: `GET /users as admin -> ${list.status}, admin not listed` }
    await expect('admin demotes self', adm, 'PATCH', `/users/${me.id}`, { role: 'user' }, 400)
    // promoting a user revokes their old token; their next login carries the new role
    const c = await newUser('carol')
    await expect('promote carol, as admin', adm, 'PATCH', `/users/${c.id}`, { role: 'admin' }, 204)
    await expect("carol's old token after the role change", c.token, 'GET', '/sessions/mine', undefined, 401)
    const relog = await api('POST', '/auth/login', undefined, { email: c.email, password: c.password })
    rows.push(["carol's new login role", relog.json?.role, 'admin'])
    const bad = rows.filter(([, got, want]) => got !== want)
    return { ok: bad.length === 0, detail: bad.length ? `FAILED: ${bad.map(([l, g, w]) => `${l}: got ${g}, want ${w}`).join('; ')}` : `${rows.length} checks` }
  },

  // The OWNER's role reaches the runtime with every connect (it is what analyze_data limits data by).
  async roleReachesRuntime() {
    const { a } = await users()
    const adm = await admin()
    const cu = chat(a.token, { params: { flow: 'default' } }); await cu.opened; await cu.ready()
    const ca = chat(adm, { params: { flow: 'default' } }); await ca.opened; await ca.ready()
    await sleep(500)
    // the runtime's ws_connect (it carries the role the agent runs with), one JSON object per log line
    const connects = (id) => execFileSync('docker', ['logs', BACKEND], { encoding: 'utf8' }).split('\n')
      .map((line) => { try { return JSON.parse(line) } catch { return undefined } })
      .filter((r) => r?.event === 'ws_connect' && r.service === 'transport' && r.sessionId === id)
      .map((r) => r.role)
    const roleOf = (id) => connects(id)[0]
    const ru = roleOf(cu.sessionId), ra = roleOf(ca.sessionId)
    // an admin opening the USER's session still runs it with the owner's role
    const view = chat(adm, { session: cu.sessionId }); await view.opened; await view.ready(); await sleep(300)
    const viewRoles = connects(cu.sessionId)
    cu.close(); ca.close(); view.close()
    return { ok: ru === 'user' && ra === 'admin' && viewRoles.every((r) => r === 'user'), detail: `user session role=${ru}, admin session role=${ra}, admin viewing the user's session -> ${JSON.stringify(viewRoles)}` }
  },

  // Model-run bash/python get their own network namespace (fox-confine.sh --unshare-net): measured before the fix,
  // confined code reached the gateway's Redis (login tokens) without a password, Mongo, MariaDB and the internet.
  async sandboxNoNetwork() {
    if (SANDBOX_MODE === 'none') return skippedWithoutSandbox
    const { a } = await users()
    const c = chat(a.token, { params: { flow: 'default' } }); await c.opened; await c.ready()
    const targets = [['foxe2e-redis', 6379], ['foxe2e-mariadb', 3306], ['127.0.0.1', 4000], ['foxe2e-backend', 4000], ['host.docker.internal', 4999], ['example.com', 443]]
    const rows = []
    let n = 0
    for (const [host, port] of targets) {
      c.send(`CALL bash ${JSON.stringify({ command: `timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port}' 2>/dev/null && echo NET-OPEN-${port} || echo NET-CLOSED`, description: 'net' })}`); n += 1
      await c.turnEnds(n, 40000).catch(() => {})
      rows.push([`bash -> ${host}:${port}`, toolText(c.events).includes(`NET-OPEN-${port}`)])
      const code = `import socket\ntry:\n    socket.create_connection((${JSON.stringify(host)}, ${port}), 5); print('NET-OPEN-${port}')\nexcept Exception as e:\n    print('NET-CLOSED', type(e).__name__)`
      c.send(`CALL python ${JSON.stringify({ code })}`); n += 1
      await c.turnEnds(n, 90000).catch(() => {})
      rows.push([`python -> ${host}:${port}`, toolText(c.events).includes(`NET-OPEN-${port}`)])
    }
    // no capability left (a root bwrap keeps them all by default; measured: CAP_SYS_ADMIN before --cap-drop ALL)
    c.send(`CALL bash ${JSON.stringify({ command: "grep CapEff /proc/self/status | sed 's/.*:\\s*/CAPS:/'", description: 'caps' })}`); n += 1
    await c.turnEnds(n, 40000).catch(() => {})
    const caps = (toolText(c.events).match(/CAPS:([0-9a-f]+)/) ?? [])[1]
    // control: the sandbox still runs code
    c.send(`CALL bash ${JSON.stringify({ command: 'echo SANDBOX-RUNS', description: 'ok' })}`); n += 1
    await c.turnEnds(n, 40000).catch(() => {})
    const control = toolText(c.events).includes('SANDBOX-RUNS')
    c.close()
    const open = rows.filter(([, reached]) => reached).map(([l]) => l)
    return { ok: open.length === 0 && /^0+$/.test(caps ?? '') && control, detail: `${rows.length} probes, reachable=${JSON.stringify(open)}, CapEff=${caps}, control=${control}` }
  },

  // FOX_SANDBOX_MODE: strict confines model code (sandboxNoNetwork & co. above prove it); none runs it unconfined but
  // must still run (bash and python), keep secrets out of the command's environment, start in the workspace and say
  // so loudly at boot. Each mode must report itself in the backend log.
  async sandboxMode() {
    const logs = execFileSync('docker', ['logs', BACKEND], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const announced = logs.includes('"sandbox_disabled"')
    if (SANDBOX_MODE !== 'none') return { ok: !announced, detail: `strict: sandbox_disabled logged=${announced}` }
    const { a } = await users()
    const c = chat(a.token, { params: { flow: 'default' } }); await c.opened; await c.ready()
    c.send(`CALL bash ${JSON.stringify({ command: 'echo BASH-RUNS; pwd; env | cut -d= -f1 | sort | tr "\\n" " "', description: 'mode' })}`)
    await c.turnEnds(1, 40000).catch(() => {})
    const bashOut = toolText(c.events)
    const p = chat(a.token, { params: { flow: 'data-analysis' } }); await p.opened; await p.ready()
    p.send(`CALL python ${JSON.stringify({ code: "import os\nprint('PY-RUNS', sorted(k for k in os.environ if 'KEY' in k or 'PASS' in k or 'SECRET' in k or 'TOKEN' in k))" })}`)
    await p.turnEnds(1, 90000).catch(() => {})
    const pyOut = toolText(p.events)
    c.close(); p.close()
    const secretVars = /OPENAI_API_KEY|DATABASE_URL|REDIS_URL|S3_SECRET|FOX_INTERNAL_SECRET|MONGODB_URL/.test(bashOut)
    const inWorkspace = new RegExp(`/data/users/[0-9]+/${c.sessionId}`).test(bashOut)
    const ok = announced && bashOut.includes('BASH-RUNS') && !secretVars && inWorkspace && pyOut.includes("PY-RUNS []")
    return { ok, detail: `none: announced=${announced} bash=${bashOut.includes('BASH-RUNS')} secrets in env=${secretVars} in workspace=${inWorkspace} python=${pyOut.includes('PY-RUNS')} py secret vars=${(pyOut.match(/PY-RUNS (\[[^\]]*\])/) ?? [])[1]}` }
  },

  // Redis holds only SHA-256 hashes of login tokens: a Redis dump or a reader on the network gets nothing to log in with.
  async tokensHashedInRedis() {
    const u = await newUser('dave')
    const keys = execFileSync('docker', ['exec', 'foxe2e-redis', 'redis-cli', '--scan', '--pattern', 'fh:*'], { encoding: 'utf8' })
    const members = execFileSync('docker', ['exec', 'foxe2e-redis', 'redis-cli', 'smembers', `fh:gwuser:${u.id}`], { encoding: 'utf8' })
    const rawInRedis = keys.includes(u.token) || members.includes(u.token)
    const works = (await api('GET', '/sessions/mine', u.token)).status === 200
    await api('POST', '/auth/logout', u.token)
    const revoked = (await api('GET', '/sessions/mine', u.token)).status === 401
    return { ok: !rawInRedis && works && revoked, detail: `raw token in redis=${rawInRedis}, token works=${works}, logout revokes=${revoked}` }
  },

  // 2026-10-06 gateway hardening: login limit per email (a burst on one email must not lock out others), body cap,
  // single-use WebSocket tickets instead of a token in the URL, no `?token=` on HTTP, no wildcard CORS, a per-user
  // chat message limit and a per-user limit on uploads.
  async gatewayLimits() {
    const rows = []
    const u = await newUser('erin')
    const bursts = []
    for (let i = 0; i < 11; i++) bursts.push((await api('POST', '/auth/login', undefined, { email: 'nobody@e2e.test', password: 'wrong-password' })).status)
    rows.push(['11th bad login on one email', bursts[10], 429])
    rows.push(['another user still logs in', (await api('POST', '/auth/login', undefined, { email: u.email, password: u.password })).status, 200])
    rows.push(['2 MB JSON body', (await api('POST', '/projects', u.token, { name: 'x'.repeat(2 * 1024 * 1024) })).status, 413])
    rows.push(['?token= on HTTP', (await fetch(`${BASE}/sessions/mine?token=${u.token}`)).status, 401])
    const cors = await fetch(`${BASE}/sessions/mine`, { headers: { origin: 'https://evil.example', authorization: `Bearer ${u.token}` } })
    rows.push(['CORS for a foreign origin', cors.headers.get('access-control-allow-origin') ?? 'none', 'none'])
    const ready = await (await fetch(`${BASE}/readyz`)).json()
    rows.push(['/readyz shows no ports', JSON.stringify(ready).includes('port'), false])
    const ticket = await wsTicket(u.token)
    const first = chat(u.token, { params: { flow: 'default' }, ticket }); rows.push(['ws with a ticket', await first.opened, true]); await first.ready()
    const reused = chat(u.token, { params: { flow: 'default' }, ticket }); await reused.opened; await sleep(300)
    rows.push(['ws ticket used twice', reused.status, 401])
    const raw = new WebSocket(`${WS_BASE}/sessions/new?token=${u.token}&flow=default`)
    const rawStatus = await new Promise((resolve) => { raw.on('unexpected-response', (_q, r) => resolve(r.statusCode)); raw.on('open', () => resolve('open')); raw.on('error', () => resolve('error')) })
    rows.push(['ws with ?token=', rawStatus, 401])
    const chatLimit = Number(process.env.E2E_CHAT_LIMIT ?? 60)   // scripts/e2e-up.sh passes the same value
    for (let i = 0; i <= chatLimit; i++) first.send(`ping ${i}`)
    await first.waitFor((x) => x.errors.some((e) => e.includes('Too many messages')), 20000, 'chat rate limit').catch(() => undefined)
    rows.push([`message ${chatLimit + 1} in a minute refused`, first.errors.some((e) => e.includes('Too many messages')), true])
    // uploads go to the chat's working folder
    const da = chat(u.token, { params: { flow: 'data-analysis' } }); await da.opened; await da.ready()
    const sid = da.sessionId
    const uploads = []
    for (let i = 0; i < 11; i++) uploads.push((await api('POST', `/sessions/${sid}/files?name=f${i}.txt`, u.token, 'x', true)).status)
    rows.push(['first 10 uploads', JSON.stringify(uploads.slice(0, 10)), JSON.stringify(Array(10).fill(201))])
    rows.push(['11th upload in a minute', uploads[10], 429])
    da.close()
    first.close()
    const bad = rows.filter(([, got, want]) => got !== want)
    return { ok: bad.length === 0, detail: bad.length ? `FAILED: ${bad.map(([l, g, w]) => `${l}: got ${g}, want ${w}`).join('; ')}` : `${rows.length} checks` }
  },

  // Per-user dashboards (docs/data-studio-user-dashboards-plan.md): each user sees, edits and pins into only their own
  // dashboards, and only their own charts. Charts are made by analyze_data (Python + Dremio, not in this stack), so
  // two are written straight into Mongo with an owner, as bridge/runner.py does.
  async dashboardOwnership() {
    const rows = []
    const [a, b] = [await newUser('fay'), await newUser('gus')]
    const chartA = randomUUID(), chartB = randomUUID()
    const doc = (id, owner) => `{_id:"${id}",owner_id:${owner},query_result_id:"none",type:"bar",title:"t",x:"k",y_json:["v"],rows_json:[{k:"a",v:1}],created_at:new Date(),updated_at:new Date()}`
    execFileSync('docker', ['exec', 'foxe2e-mongo', 'mongosh', '--quiet', 'bot_data_studio', '--eval', `db.charts.insertMany([${doc(chartA, a.id)},${doc(chartB, b.id)}])`])
    const made = await api('POST', '/data-studio/dashboards', a.token, { title: 'A board' })
    rows.push(['user creates a dashboard', made.status, 201])
    const dash = made.json?.id
    rows.push(['A pins own chart', (await api('POST', `/data-studio/dashboards/${dash}/charts`, a.token, { chart_id: chartA })).status, 200])
    rows.push(["A pins B's chart", (await api('POST', `/data-studio/dashboards/${dash}/charts`, a.token, { chart_id: chartB })).status, 404])
    rows.push(["A adds B's chart through the layout", (await api('PUT', `/data-studio/dashboards/${dash}/widgets`, a.token, { widgets: [{ id: 'fake', kind: 'chart', chart_id: chartB }] })).status, 404])
    rows.push(['A sees it', (await api('GET', `/data-studio/dashboards/${dash}`, a.token)).json?.widgets?.length, 1])
    rows.push(["B's list", JSON.stringify((await api('GET', '/data-studio/dashboards', b.token)).json), '[]'])
    rows.push(["B opens A's dashboard", (await api('GET', `/data-studio/dashboards/${dash}`, b.token)).status, 404])
    rows.push(["B renames it", (await api('PATCH', `/data-studio/dashboards/${dash}`, b.token, { title: 'x' })).status, 404])
    rows.push(["B pins into it", (await api('POST', `/data-studio/dashboards/${dash}/charts`, b.token, { chart_id: chartB })).status, 404])
    rows.push(["B edits A's chart", (await api('PATCH', `/data-studio/charts/${chartA}`, b.token, { title_override: 'x' })).status, 404])
    rows.push(['A edits own chart', (await api('PATCH', `/data-studio/charts/${chartA}`, a.token, { title_override: 'mine' })).status, 200])
    const availA = (await api('GET', '/data-studio/dashboards/meta/available-charts', a.token)).json ?? []
    rows.push(['available charts = own only', JSON.stringify(availA.map((c) => c.chart_id)), JSON.stringify([chartA])])
    const adminList = (await api('GET', '/data-studio/dashboards', await admin())).json ?? []
    rows.push(["admin's list has no user's dashboard", adminList.some((d) => d.id === dash), false])
    rows.push(["B deletes it", (await api('DELETE', `/data-studio/dashboards/${dash}`, b.token)).status, 404])
    rows.push(['A deletes it', (await api('DELETE', `/data-studio/dashboards/${dash}`, a.token)).status, 200])
    const bad = rows.filter(([, got, want]) => got !== want)
    return { ok: bad.length === 0, detail: bad.length ? `FAILED: ${bad.map(([l, g, w]) => `${l}: got ${g}, want ${w}`).join('; ')}` : `${rows.length} checks` }
  },

  // Vietnamese and emoji round-trip through the gateway and MariaDB (the e2e database defaults to latin1), and an
  // over-long email is a 400, not a database error.
  async unicodeText() {
    const { a } = await users()
    const text = 'Phân tích doanh thu quý 3 của Đức — ưu tiên 📊'
    const c = chat(a.token, { params: { flow: 'default' } }); await c.opened; await c.ready()
    c.send('MARK-UNI hi'); await c.turnEnds(1)
    const id = c.sessionId; c.close()
    const rename = await api('PATCH', `/sessions/${id}`, a.token, { title: text })
    const mine = await api('GET', '/sessions/mine', a.token)
    const row = (Array.isArray(mine.json) ? mine.json : mine.json?.sessions ?? []).find((s) => (s.sessionId ?? s.session_id ?? s.id) === id)
    const project = await api('POST', '/projects', a.token, { name: 'Dự án Báo cáo — tháng 9 ✍️' })
    const projects = await api('GET', '/projects', a.token)
    const projectBack = JSON.stringify(projects.json).includes('Dự án Báo cáo — tháng 9 ✍️')
    const longEmail = await api('POST', '/users', await admin(), { email: `${'x'.repeat(250)}@e2e.test`, password: 'correct-horse-battery' })
    return {
      ok: rename.status === 204 && row?.title === text && project.status === 201 && projectBack && longEmail.status === 400,
      detail: `rename=${rename.status} title back=${JSON.stringify(row?.title)} project=${project.status} name back=${projectBack} email>255=${longEmail.status}`,
    }
  },

  // No vendor service is ever wired in: the runtime's EFFECTIVE configuration (dsh --dump-config) keeps dsh's
  // session telemetry (harness-telemetry.deepseeksvc.com), the DeepSeek adapters (api.deepseek.com) and the
  // pi-ai multi-provider adapter disabled, the default model route is ours, and the runtimes run opted out.
  async noVendorServices() {
    const dump = dx('sh', '-c', 'DSH_HOME=/data/dsh-home FOX_REPO_ROOT=/repo FOX_DATA_DIR=/data node --expose-internals /repo/node_modules/@deepseek-ai/dsh/lib/bin.js --profile fox-harness --dump-config')
    const row = (id) => (dump.match(new RegExp(`(?:^|\\n)- id: ${id}\\n(?:  .*\\n)*`)) ?? [''])[0]
    const off = ['session-telemetry-otel', 'llm-deepseek', 'web-search-deepseek', 'llm-pi-ai'].filter((id) => !/\n  disabled: true\n/.test(row(id)))
    const defaultRoute = /provider: openai-compat/.test(row('agent-default-model'))
    const envs = dx('sh', '-c', 'for p in /proc/[0-9]*; do [ "$p" = "/proc/$$" ] && continue; tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q -- "bin.js --profile fox-harness" && tr "\\0" "\\n" < $p/environ | grep -c "^DSH_TELEMETRY_DISABLED=1$"; done; true')
    const optedOut = envs.trim().split('\n').filter(Boolean)
    return {
      ok: off.length === 0 && defaultRoute && optedOut.length > 0 && optedOut.every((n) => n === '1'),
      detail: `still enabled=${JSON.stringify(off)}, default route openai-compat=${defaultRoute}, runtimes opted out=${JSON.stringify(optedOut)}`,
    }
  },

  async purge() {
    const { a } = await users()
    const c = chat(a.token, { params: { flow: 'default' } }); await c.opened; await c.ready()
    c.send('to be deleted'); await c.turnEnds(1)
    const id = c.sessionId
    const dir = workspaceOf(id)
    const existedBefore = dx('sh', '-c', `test -d ${dir} && echo yes || echo no`).trim()
    const logsBefore = dx('sh', '-c', `ls -d /data/dsh-home/sessions/*/${id} 2>/dev/null | wc -l`).trim()
    const del = await api('DELETE', `/sessions/${id}`, a.token)
    await sleep(500)
    const existsAfter = dx('sh', '-c', `test -d ${dir} && echo yes || echo no`).trim()
    const logsAfter = dx('sh', '-c', `ls -d /data/dsh-home/sessions/*/${id} 2>/dev/null | wc -l`).trim()
    const again = chat(a.token, { session: id }); await again.opened; await sleep(300)
    const mine = await api('GET', '/sessions/mine', a.token)
    return { ok: del.status === 204 && existedBefore === 'yes' && existsAfter === 'no' && logsBefore !== '0' && logsAfter === '0' && c.closed && again.status !== undefined && !mine.json.some((r) => r.sessionId === id), detail: `dir ${existedBefore}->${existsAfter}, logs ${logsBefore}->${logsAfter}, viewer closed=${c.closed}, reopen status=${again.status}` }
  },
  // Chat attachments (docs/chat-attachments-plan.md): a regular chat now has the files API; an attachment with a
  // taken name gets a new one instead of replacing it; the message's marker line names the files and the model
  // reads them from its working directory; Data Studio still has no files; another user cannot reach them.
  async chatAttachments() {
    const rows = []
    const { a, b } = await users()
    const c = chat(a.token, { params: { flow: 'default' } }); await c.opened; await c.ready()
    const sid = c.sessionId
    const up = async (body) => api('POST', `/sessions/${sid}/files?unique=1&name=notes.txt`, a.token, body, true)
    const first = await up('first version'); const second = await up('ATTACHED-CONTENT-42')
    rows.push(['upload in a regular chat', first.status, 201])
    rows.push(['same name again → new name', second.json?.path, 'notes (2).txt'])
    rows.push(['first file kept', (await api('GET', `/sessions/${sid}/files/notes.txt`, a.token)).text, 'first version'])
    // several attachments upload at once (the composer does): every one recorded, the listing still works
    const parallel = await Promise.all(['p1.csv', 'p2.csv', 'p3.csv'].map((n) => api('POST', `/sessions/${sid}/files?unique=1&name=${n}`, a.token, n, true)))
    rows.push(['3 uploads at once', JSON.stringify(parallel.map((r) => r.status)), '[201,201,201]'])
    const listed = await api('GET', `/sessions/${sid}/files`, a.token)
    rows.push(['listing after them', `${listed.status}:${['p1.csv', 'p2.csv', 'p3.csv'].every((n) => listed.json?.files?.some((f) => f.path === n && f.origin === 'source'))}`, '200:true'])
    const names = JSON.stringify([second.json?.path])
    c.send(`CALL bash ${JSON.stringify({ command: "cat 'notes (2).txt'", description: 'read attachment' })}\n\n[Attached files in the working directory: ${names}]`)
    await c.turnEnds(1, 40000).catch(() => {})
    rows.push(['model reads the attachment', toolText(c.events).includes('ATTACHED-CONTENT-42'), true])
    const userText = JSON.stringify(c.events.filter((e) => e.type === 'user/message').map((e) => e.data.message?.content ?? e.data.content))
    rows.push(['marker kept in the message', userText.includes('Attached files in the working directory'), true])
    rows.push(["another user can't list them", (await api('GET', `/sessions/${sid}/files`, b.token)).status, 404])
    // a card taken off before sending deletes its file (the composer's ×)
    rows.push(["another user can't delete one", (await api('DELETE', `/sessions/${sid}/files/p1.csv`, b.token)).status, 404])
    rows.push(['owner deletes one', (await api('DELETE', `/sessions/${sid}/files/p1.csv`, a.token)).status, 204])
    const afterDelete = await api('GET', `/sessions/${sid}/files`, a.token)
    rows.push(['gone from the list', afterDelete.json?.files?.some((f) => f.path === 'p1.csv'), false])
    rows.push(['source record updated', dx('sh', '-c', `cat /data/users/*/${sid}/.fox/sources.json`).includes('p1.csv'), false])
    rows.push(['deleting it again', (await api('DELETE', `/sessions/${sid}/files/p1.csv`, a.token)).status, 404])
    rows.push(['delete outside the folder', (await api('DELETE', `/sessions/${sid}/files/..%2F..%2Fsecret`, a.token)).status, 404])
    c.close()
    const ds = chat(a.token, { params: { flow: 'data-studio' } }); await ds.opened; await ds.ready()
    rows.push(['Data Studio has no files', (await api('POST', `/sessions/${ds.sessionId}/files?unique=1&name=x.txt`, a.token, 'x', true)).status, 404])
    ds.close()
    const bad = rows.filter(([, got, want]) => got !== want)
    return { ok: bad.length === 0, detail: bad.length ? `FAILED: ${bad.map(([l, g, w]) => `${l}: got ${g}, want ${w}`).join('; ')}` : `${rows.length} checks` }
  },

  // A Data Studio chat's log holds `fox/data-studio-progress` events (the live steps). dsh refused to resume a log
  // with an event type it does not know, so such a chat failed to reopen ("unknown session") once the runtime let
  // go of it. analyze_data has no Dremio here and fails, but only after its first steps were logged.
  async dataStudioResume() {
    const { a } = await users()
    const c = chat(a.token, { params: { flow: 'data-studio' } }); await c.opened; await c.ready()
    c.send(`CALL analyze_data ${JSON.stringify({ question: 'Có bao nhiêu workflow?' })}`)
    await c.turnEnds(1, 180000)
    const progress = c.events.filter((e) => e.type === 'fox/data-studio-progress').length
    const id = c.sessionId; c.close()
    await sleep(15000) // FOX_IDLE_DISPOSE_MS=8000
    const again = chat(a.token, { session: id }); await again.opened
    const reopened = await again.ready().then(() => true, () => false)
    const replayed = again.events.filter((e) => e.type === 'fox/data-studio-progress').length
    again.close()
    return { ok: progress > 0 && reopened && replayed === progress && again.errors.length === 0, detail: `progress events=${progress}, reopened=${reopened}, replayed=${replayed}, errors=${JSON.stringify(again.errors)}` }
  },

  // Session logs go to S3 (sessions/<owner>/<session>/...), come back when a chat whose log left the disk is reopened,
  // and a purge deletes every copy and version. SESSION_ARCHIVE_INTERVAL_MS=2000 in scripts/e2e-up.sh.
  async sessionArchive() {
    const rows = []
    const { a } = await users()
    const c = chat(a.token, { params: { flow: 'default' } }); await c.opened; await c.ready()
    c.send('archive me'); await c.turnEnds(1)
    const id = c.sessionId; c.close()
    const prefix = `sessions/${a.id}/${id}/`
    let keys = []
    for (let i = 0; i < 30 && keys.length === 0; i++) { await sleep(1000); keys = s3('versions', prefix) }
    rows.push(['log archived to S3', keys.length > 0, true])
    // the 12-month lifecycle rule was removed (2026-10-14): the gateway leaves the bucket's lifecycle alone
    rows.push(['no lifecycle rule from the gateway', s3('lifecycle').length, 0])
    await sleep(15000) // FOX_IDLE_DISPOSE_MS=8000: the runtime lets go of the chat
    dx('sh', '-c', `rm -rf /data/dsh-home/sessions/*/${id}`) // as the local-retention eviction does
    rows.push(['log gone from disk', dx('sh', '-c', `ls -d /data/dsh-home/sessions/*/${id} 2>/dev/null | wc -l`).trim(), '0'])
    const again = chat(a.token, { session: id }); await again.opened; await again.ready()
    again.send('after restore'); await again.turnEnds(2)
    again.close()
    rows.push(['history restored from S3', JSON.stringify(turnsOf(again.events)), '[1,2]'])
    await sleep(500)
    rows.push(['purge', (await api('DELETE', `/sessions/${id}`, a.token)).status, 204])
    rows.push(['no object or version left', JSON.stringify(s3('versions', prefix)), '[]'])
    const bad = rows.filter(([, got, want]) => got !== want)
    return { ok: bad.length === 0, detail: bad.length ? `FAILED: ${bad.map(([l, g, w]) => `${l}: got ${g}, want ${w}`).join('; ')}` : `${rows.length} checks, ${keys.length} object(s)` }
  },

  // A working directory's files — an upload and what python wrote — go to S3 (files/users/<owner>/<session>/...),
  // come back when the folder left the disk and the chat is opened again, and a purge deletes every copy
  // (docs/workspace-archive-plan.md).
  async workspaceArchive() {
    const rows = []
    const { a } = await users()
    const c = chat(a.token, { params: { flow: 'data-analysis' } }); await c.opened; await c.ready()
    const id = c.sessionId
    const csv = 'region,amount\nN,1\n'
    rows.push(['upload', (await api('POST', `/sessions/${id}/files?name=sales.csv`, a.token, csv, true)).status, 201])
    // the python tool moves what a cell wrote into generated/<session>/
    c.send(`CALL python ${JSON.stringify({ code: "open('report.txt', 'w').write('made by python')" })}`); await c.turnEnds(1, 90000)
    c.close()
    const dir = workspaceOf(id)
    const prefix = `files/${dir.replace(/^\/data\//, '')}/`
    let keys = []
    for (let i = 0; i < 30 && !(keys.includes(`${prefix}sales.csv`) && keys.includes(`${prefix}generated/${id}/report.txt`)); i++) {
      await sleep(1000); keys = s3('versions', prefix)
    }
    rows.push(['upload on S3', keys.includes(`${prefix}sales.csv`), true])
    rows.push(['python output on S3', keys.includes(`${prefix}generated/${id}/report.txt`), true])
    rows.push(['skills not archived', keys.some((k) => k.includes('/.dsh/')), false])
    await sleep(15000) // FOX_IDLE_DISPOSE_MS=8000: the runtime lets go of the chat
    dx('sh', '-c', `rm -rf ${dir}`) // the folder left the disk, as the local-retention eviction does
    const again = chat(a.token, { session: id }); await again.opened; await again.ready(); again.close()
    rows.push(['upload restored', (await api('GET', `/sessions/${id}/files/sales.csv`, a.token)).text, csv])
    rows.push(['python output restored', (await api('GET', `/sessions/${id}/files/generated/${id}/report.txt`, a.token)).text, 'made by python'])
    await sleep(500)
    rows.push(['purge', (await api('DELETE', `/sessions/${id}`, a.token)).status, 204])
    rows.push(['no object or version left', JSON.stringify(s3('versions', prefix)), '[]'])
    const bad = rows.filter(([, got, want]) => got !== want)
    return { ok: bad.length === 0, detail: bad.length ? `FAILED: ${bad.map(([l, g, w]) => `${l}: got ${g}, want ${w}`).join('; ')}` : `${rows.length} checks, ${keys.length} object(s)` }
  },

  // docs/storage-quota-plan.md (e2e-up.sh sets USER_FILE_QUOTA_BYTES=2 MB): an upload past the quota is refused with
  // storage_quota until the user deletes files; GET /storage lists them; a folder can be emptied; the admin cleanup
  // deletes the files of a chat unused for N days (dry run first), also of a folder that left the disk.
  async storageQuota() {
    const rows = []
    const u = await newUser('quota')
    const c = chat(u.token); await c.opened; await c.ready(); c.close()
    const id = c.sessionId
    const MB = 1024 * 1024
    const up = (name, bytes) => api('POST', `/sessions/${id}/files?name=${name}`, u.token, 'x'.repeat(bytes), true)
    rows.push(['1.5 MB upload', (await up('big.bin', 1.5 * MB)).status, 201])
    const refused = await up('more.bin', MB)
    rows.push(['past the quota', `${refused.status} ${refused.json?.code}`, '507 storage_quota'])
    const listed = (await api('GET', '/storage', u.token)).json
    rows.push(['GET /storage', `${listed.usedBytes >= 1.5 * MB} ${listed.quotaBytes} ${listed.dirs[0]?.files.map((f) => f.path).join(',')}`, `true ${2 * MB} big.bin`])
    rows.push(['delete a file', (await api('DELETE', `/sessions/${id}/files/big.bin`, u.token)).status, 204])
    rows.push(['upload again', (await up('more.bin', MB)).status, 201])
    const cleared = await api('DELETE', `/storage/sessions/${id}`, u.token)
    rows.push(['empty the folder', `${cleared.status} ${cleared.json?.files}`, '200 1'])
    rows.push(['nothing left', (await api('GET', '/storage', u.token)).json.dirs.length, 0])
    rows.push(['someone else cannot', (await api('DELETE', `/storage/sessions/${id}`, (await users()).b.token)).status, 404])

    // unused for 40 days: the session row and the file, both dated back
    rows.push(['old upload', (await up('old.csv', 1000)).status, 201])
    const dir = workspaceOf(id)
    const dirKey = dir.replace(/^\/data\//, '')
    const key = `files/${dirKey}/old.csv`
    const old = Math.floor(Date.now() / 1000) - 40 * 86400
    dx('touch', '-d', `@${old}`, `${dir}/old.csv`)
    execFileSync('docker', ['exec', 'foxe2e-mariadb', 'mariadb', '-uroot', '-px', 'discovery-agent', '-e',
      `update discovery_sessions set updated_at = now() - interval 40 day where session_id = '${id}'`])
    for (let i = 0; i < 20 && !s3('versions', key).includes(key); i++) await sleep(1000)
    rows.push(['archived', s3('versions', key).includes(key), true])
    rows.push(['user cannot run the cleanup', (await api('POST', '/admin/storage/cleanup', u.token, { olderThanDays: 30 })).status, 403])
    const dry = (await api('POST', '/admin/storage/cleanup', await admin(), { olderThanDays: 30, userId: u.id, dryRun: true })).json
    rows.push(['dry run', `${dry.dirs} ${dry.files} ${dry.bytes}`, '1 1 1000'])
    rows.push(['dry run deletes nothing', (await api('GET', `/sessions/${id}/files/old.csv`, u.token)).status, 200])
    const done = (await api('POST', '/admin/storage/cleanup', await admin(), { olderThanDays: 30, userId: u.id })).json
    rows.push(['cleanup', `${done.dirs} ${done.files}`, '1 1'])
    rows.push(['gone from the disk', (await api('GET', `/sessions/${id}/files/old.csv`, u.token)).status, 404])
    rows.push(['gone from S3', s3('versions', key).includes(key), false])
    rows.push(['the chat stays', (await api('GET', `/sessions/${id}/files`, u.token)).status, 200])

    // a folder that left the disk (evicted): listed from what Redis recorded, a delete goes to S3 only
    rows.push(['upload to evict', (await up('far.csv', 500)).status, 201])
    const farKey = `files/${dirKey}/far.csv`
    for (let i = 0; i < 20 && !s3('versions', farKey).includes(farKey); i++) await sleep(1000)
    execFileSync('docker', ['exec', 'foxe2e-redis', 'redis-cli', 'sadd', 'fh:workspace-evicted', dirKey])
    dx('sh', '-c', `rm -rf ${dir}`)
    const evicted = (await api('GET', '/storage', u.token)).json
    rows.push(['evicted folder listed', evicted.dirs[0]?.files.map((f) => f.path).join(','), 'far.csv'])
    rows.push(['delete from S3 only', (await api('DELETE', `/sessions/${id}/files/far.csv`, u.token)).status, 204])
    rows.push(['not downloaded to delete it', dx('sh', '-c', `test -e ${dir}/far.csv && echo yes || echo no`).trim(), 'no'])
    rows.push(['gone from S3 (evicted)', s3('versions', farKey).includes(farKey), false])

    const overview = (await api('GET', '/admin/storage', await admin())).json
    rows.push(['bucket measured', typeof overview.bucket.usedBytes, 'number'])
    rows.push(['user listed', overview.users.some((x) => x.email === u.email), true])
    const bad = rows.filter(([, got, want]) => got !== want)
    return { ok: bad.length === 0, detail: bad.length ? `FAILED: ${bad.map(([l, g, w]) => `${l}: got ${g}, want ${w}`).join('; ')}` : `${rows.length} checks` }
  },

  // docs/workspace-symlink-isolation-plan.md: links the model's python could put in its own folder (planted here
  // with docker exec) never make the gateway read, write or delete what they point to.
  async symlinkIsolation() {
    const rows = []
    const a = await newUser('linka')
    const b = await newUser('linkb')
    const ca = chat(a.token); await ca.opened; await ca.ready(); ca.close()
    const cb = chat(b.token); await cb.opened; await cb.ready(); cb.close()
    const up = (token, id, name, body) => api('POST', `/sessions/${id}/files?name=${encodeURIComponent(name)}`, token, body, true)
    rows.push(['A uploads', (await up(a.token, ca.sessionId, 'ok.csv', 'a,b\n1,2\n')).status, 201])
    rows.push(['B uploads', (await up(b.token, cb.sessionId, 'secret.csv', 'B-SECRET')).status, 201])
    const aDir = workspaceOf(ca.sessionId)
    const bDir = workspaceOf(cb.sessionId)
    const bait = '/data/bait.txt'
    dx('sh', '-c', `printf BAIT > ${bait}
      cd ${aDir} && ln -s /proc/self/environ env.txt && ln -s ${bDir}/secret.csv other.csv && ln -s ${bDir} dir_link \
        && ln -s ${bait} .up.csv.part`)
    const cat = (path) => { try { return dx('cat', path) } catch { return '(missing)' } }
    const get = (path) => api('GET', `/sessions/${ca.sessionId}/files/${path}`, a.token)

    const env = await get('env.txt')
    rows.push(['env link → 404', env.status, 404])
    rows.push(['no gateway env in the answer', /S3_SECRET_ACCESS_KEY|DATABASE_URL/.test(env.text), false])
    rows.push(["link to B's file → 404", (await get('other.csv')).status, 404])
    rows.push(["B's file through a linked folder → 404", (await get('dir_link/secret.csv')).status, 404])
    const ok = await get('ok.csv')
    rows.push(['a real file still downloads', `${ok.status} ${ok.text}`, '200 a,b\n1,2\n'])
    rows.push(['links not listed', (await api('GET', `/sessions/${ca.sessionId}/files`, a.token)).json.files.map((f) => f.path).sort().join(','), 'ok.csv'])

    rows.push(["delete B's file through a linked folder → 404", (await api('DELETE', `/sessions/${ca.sessionId}/files/dir_link/secret.csv`, a.token)).status, 404])
    rows.push(["B's file still there", cat(`${bDir}/secret.csv`), 'B-SECRET'])
    rows.push(['delete a link → 404', (await api('DELETE', `/sessions/${ca.sessionId}/files/other.csv`, a.token)).status, 404])

    rows.push(['upload past a planted .part link', (await up(a.token, ca.sessionId, 'up.csv', 'UPLOADED')).status, 201])
    rows.push(['the link target is untouched', cat(bait), 'BAIT'])
    rows.push(['the upload landed', (await get('up.csv')).text, 'UPLOADED'])

    // the archive sweep reads through safe-fs too: a link is never copied to S3
    const dirKey = aDir.replace(/^\/data\//, '')
    // a fresh MinIO has no bucket until the first sweep writes one
    const listed = (prefix) => { try { return s3('versions', prefix) } catch { return [] } }
    for (let i = 0; i < 30 && !listed(`files/${dirKey}/up.csv`).length; i++) await sleep(1000)
    const archived = listed(`files/${dirKey}/`).map((key) => key.slice(`files/${dirKey}/`.length)).filter((p) => !p.startsWith('.')).sort().join(',')
    rows.push(['archived: the real files only', archived, 'ok.csv,up.csv'])

    // a restore writes through safe-fs: the folder left the disk, a link waits where the restore writes its partial
    execFileSync('docker', ['exec', 'foxe2e-redis', 'redis-cli', 'sadd', 'fh:workspace-evicted', dirKey])
    dx('sh', '-c', `rm -rf ${aDir} && mkdir -p ${aDir} && ln -s ${bait} ${aDir}/.ok.csv.restore && ln -s ${bait} ${aDir}/up.csv`)
    rows.push(['restore on open', (await api('GET', `/sessions/${ca.sessionId}/files`, a.token)).status, 200])
    rows.push(['restored ok.csv is the real file', cat(`${aDir}/ok.csv`), 'a,b\n1,2\n'])
    rows.push(['restore wrote nothing through the links', cat(bait), 'BAIT'])

    // "Đưa vào dự án": a chat output that is a link is refused; an outputs/ link is replaced, not written through
    const project = (await api('POST', '/projects', a.token, { name: 'symlink e2e' })).json
    const pid = project.projectId ?? project.id
    const cp = chat(a.token, { params: { project: pid } }); await cp.opened; await cp.ready(); cp.close()
    const pDir = `/data/projects/${pid}`
    dx('sh', '-c', `mkdir -p ${pDir}/generated/${cp.sessionId} ${pDir}/outputs && cd ${pDir} \
      && ln -s ${bDir}/secret.csv generated/${cp.sessionId}/leak.csv \
      && printf REPORT > generated/${cp.sessionId}/report.csv && ln -s ${bait} outputs/report.csv`)
    const promote = (path) => api('POST', `/projects/${pid}/promote`, a.token, { sessionId: cp.sessionId, path })
    rows.push(['promote a link → 404', (await promote('leak.csv')).status, 404])
    rows.push(['promote a real file', (await promote('report.csv')).status, 201])
    rows.push(['outputs/report.csv is the real copy', cat(`${pDir}/outputs/report.csv`), 'REPORT'])
    rows.push(['the bait behind outputs/ untouched', cat(bait), 'BAIT'])

    const bad = rows.filter(([, got, want]) => got !== want)
    return { ok: bad.length === 0, detail: bad.length ? `FAILED: ${bad.map(([l, g, w]) => `${l}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`).join('; ')}` : `${rows.length} checks` }
  },

  // docs/canvas-storage-plan.md: the canvas history (.canvas/) is deduplicated, indexed, capped, counted, shown and
  // deletable; the assistant's canvas versions can be thinned or deleted.
  async canvasStorage() {
    const rows = []
    const u = await newUser('canvasstore')
    const c = chat(u.token); await c.opened; await c.ready(); c.close()
    const id = c.sessionId
    const dir = workspaceOf(id)
    const files = `/sessions/${id}/files`
    const ls = (sub) => dx('sh', '-c', `ls -1 ${dir}/${sub} 2>/dev/null || true`).trim().split('\n').filter(Boolean)
    const history = async () => (await api('GET', `/sessions/${id}/canvas`, u.token)).json?.canvases ?? {}
    const snap = (path, canvas) => api('POST', `${files}/${path}?snapshot=1&canvas=${canvas}`, u.token)
    const storageDir = async () => (await api('GET', '/storage', u.token)).json.dirs.find((d) => d.id === id)
    const used = async () => (await api('GET', '/storage', u.token)).json.usedBytes

    // 1. the same file in the same state is snapshotted once
    await api('POST', `${files}?name=bang.xlsx`, u.token, 'X'.repeat(300_000), true)
    const first = await snap('bang.xlsx', 'ws-bang')
    const again = await snap('bang.xlsx', 'ws-bang')
    const third = await snap('bang.xlsx', 'ws-bang')
    rows.push(['snapshot created', first.status, 201])
    rows.push(['opened again: same snapshot', `${again.status} ${third.status} ${again.json?.path === first.json?.path}`, '200 200 true'])
    rows.push(['one file in .canvas', ls('.canvas').filter((f) => f !== 'index.json').length, 1])
    // 2. the file changed (mtime): one more
    dx('touch', '-d', `@${Math.floor(Date.now() / 1000) + 60}`, `${dir}/bang.xlsx`)
    rows.push(['changed file: new snapshot', (await snap('bang.xlsx', 'ws-bang')).status, 201])
    rows.push(['indexed twice', (await history())['ws-bang']?.length, 2])

    // 3. 5 saved edits of one canvas: the 3 newest stay (CANVAS_HISTORY_MAX=3 in scripts/e2e-up.sh)
    for (let v = 1; v <= 5; v++) {
      await api('POST', `${files}?name=rep-${v}.md&purpose=canvas&canvas=rep&version=${v}`, u.token, `edit ${v}`, true)
    }
    const rep = (await history()).rep ?? []
    rows.push(['edits kept', `${rep.length} ${rep[0]?.version} ${rep.at(-1)?.version}`, '3 3 5'])
    rows.push(['oldest edits gone from the disk', ls('.canvas').filter((f) => /^rep-(1|2)\.md$/.test(f)).length, 0])

    // 4. a file in .canvas that no index names (older than 10 minutes) goes at the next index write
    dx('sh', '-c', `printf JUNK > ${dir}/.canvas/junk.bin && touch -d @${Math.floor(Date.now() / 1000) - 3600} ${dir}/.canvas/junk.bin`)
    await api('POST', `${files}?name=rep-6.md&purpose=canvas&canvas=rep&version=6`, u.token, 'edit 6', true)
    rows.push(['unindexed file pruned', ls('.canvas').includes('junk.bin'), false])

    // 5. counted, shown, and cleared
    const before = await storageDir()
    rows.push(['history shown', before?.canvasHistory?.files > 0 && before?.canvasHistory?.bytes > 600_000, true])
    const usedBefore = await used()
    const cleared = await api('DELETE', `/storage/sessions/${id}/canvas-history`, u.token)
    rows.push(['clear history', cleared.status, 200])
    rows.push(['usage drops by what was freed', usedBefore - (await used()), cleared.json?.bytes])
    rows.push(['.canvas empty', ls('.canvas').length, 0])
    rows.push(['the original stays', (await api('GET', `${files}/bang.xlsx`, u.token)).status, 200])

    // 6. the assistant's versions of a canvas: shown as one row, thinned, deleted
    dx('sh', '-c', `mkdir -p ${dir}/generated/${id} && for v in 1 2 3; do printf "v$v" > ${dir}/generated/${id}/canvas-rpt-v$v.md; done`)
    const shown = (await storageDir())?.canvases?.find((x) => x.id === 'rpt')
    rows.push(['canvas row', `${shown?.versions} ${shown?.latest}`, `3 generated/${id}/canvas-rpt-v3.md`])
    rows.push(['not also listed as files', (await storageDir()).files.some((f) => f.path.includes('canvas-rpt')), false])
    rows.push(['keep latest', (await api('DELETE', `/storage/sessions/${id}/canvases/rpt?keep=latest`, u.token)).json?.files, 2])
    rows.push(['v3 stays', ls(`generated/${id}`).join(','), 'canvas-rpt-v3.md'])
    rows.push(['a deleted version answers 404', (await api('GET', `${files}/generated/${id}/canvas-rpt-v1.md`, u.token)).status, 404])
    rows.push(['delete the canvas', (await api('DELETE', `/storage/sessions/${id}/canvases/rpt`, u.token)).json?.files, 1])

    // 7. no room: the snapshot is refused before a byte is written (another user: uploads are rate-limited per user)
    const u2 = await newUser('canvasstore2')
    const c2 = chat(u2.token); await c2.opened; await c2.ready(); c2.close()
    const id2 = c2.sessionId
    const dir2 = workspaceOf(id2)
    const files2 = `/sessions/${id2}/files`
    const ls2 = (sub) => dx('sh', '-c', `ls -1 ${dir2}/${sub} 2>/dev/null || true`).trim().split('\n').filter(Boolean)
    const snap2 = (path, canvas) => api('POST', `${files2}/${path}?snapshot=1&canvas=${canvas}`, u2.token)
    await api('POST', `${files2}?name=lon.csv`, u2.token, 'y'.repeat(1_200_000), true)
    const full = await snap2('lon.csv', 'ws-lon')
    rows.push(['snapshot past the quota', `${full.status} ${full.json?.code}`, '507 storage_quota'])
    rows.push(['nothing written', ls2('.canvas').filter((f) => f !== 'index.json').length, 0])

    // 8. "delete every file" takes the history too
    await api('POST', `${files2}?name=nho.csv`, u2.token, 'a,b\n1,2\n', true)
    await api('DELETE', `${files2}/lon.csv`, u2.token)
    await snap2('nho.csv', 'ws-nho')
    rows.push(['history before clearing', ls2('.canvas').filter((f) => f !== 'index.json').length, 1])
    await api('DELETE', `/storage/sessions/${id2}`, u2.token)
    rows.push(['clear all files: history gone', ls2('.canvas').filter((f) => f !== 'index.json').length, 0])

    // 9. .canvas swapped for a link: a snapshot cannot write through it
    await api('POST', `${files2}?name=nho.csv`, u2.token, 'a,b\n1,2\n', true)
    dx('sh', '-c', `mkdir -p /data/canvas-bait-dir && rm -rf ${dir2}/.canvas && ln -s /data/canvas-bait-dir ${dir2}/.canvas`)
    const linked = await snap2('nho.csv', 'ws-nho')
    rows.push(['snapshot through a linked .canvas refused', linked.status >= 400, true])
    rows.push(['nothing in the link target', dx('sh', '-c', 'ls -A /data/canvas-bait-dir | wc -l').trim(), '0'])

    // 10. a chat outside a project: the canvas lands in generated/<chat>/ and is still there after the turn
    const da = chat(u.token, { params: { flow: 'data-analysis' } }); await da.opened; await da.ready()
    da.send(`CALL canvas_write ${JSON.stringify({ id: 'note', kind: 'markdown', title: 'Note', content: '# note' })}`)
    await da.turnEnds(1, 90000); await sleep(300)
    const marker = toolText(da.events).match(/→ (\S+canvas-note-v1\.md)/)?.[1]
    da.close()
    rows.push(['canvas path', marker, `generated/${da.sessionId}/canvas-note-v1.md`])
    rows.push(['still there after the turn', (await api('GET', `/sessions/${da.sessionId}/files/${marker}`, u.token)).status, 200])

    const bad = rows.filter(([, got, want]) => got !== want)
    return { ok: bad.length === 0, detail: bad.length ? `FAILED: ${bad.map(([l, g, w]) => `${l}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`).join('; ')}` : `${rows.length} checks` }
  },

  // The same for the canvas tool (C1/C2), which runs in the runtime, outside the sandbox. Links are made by the
  // model's own python (in the sandbox) where python can reach the path, by docker exec where it cannot.
  async canvasSymlinkIsolation() {
    const rows = []
    const a = await newUser('canvasa')
    const b = await newUser('canvasb')
    const cb = chat(b.token); await cb.opened; await cb.ready(); cb.close()
    await api('POST', `/sessions/${cb.sessionId}/files?name=secret.csv`, b.token, 'B-SECRET', true)
    const bDir = workspaceOf(cb.sessionId)
    const cat = (path) => { try { return dx('cat', path) } catch { return '(missing)' } }
    const leaked = (text) => /B-SECRET|OPENAI_API_KEY|FOX_INTERNAL_SECRET|MONGODB_URL/.test(text)

    const project = (await api('POST', '/projects', a.token, { name: 'canvas symlink e2e' })).json
    const pid = project.projectId ?? project.id
    const pDir = `/data/projects/${pid}`
    const cp = chat(a.token, { params: { project: pid } }); await cp.opened; await cp.ready()
    let turns = 0
    const call = async (tool, args) => {
      cp.send(`CALL ${tool} ${JSON.stringify(args)}`)
      await cp.turnEnds(++turns, 90000)
      await sleep(300) // the result event can trail the turn's end by a frame
      return toolText(cp.events)
    }
    const canvas = (args) => call('canvas_write', { title: 'Report', ...args })

    // the python session marker is written from the runtime: a link there must not overwrite its target
    const bait = '/data/canvas-bait.txt'
    dx('sh', '-c', `printf BAIT > ${bait} && ln -s ${bait} ${pDir}/.python-session`)

    // C1, read: links made by python itself, in the sandbox
    const own = `${pDir}/generated/${cp.sessionId}`
    const planted = await call('python', { code: `import os
os.makedirs(${JSON.stringify(own)}, exist_ok=True)
open(${JSON.stringify(`${own}/real.md`)}, 'w').write('# real report')
os.symlink('/proc/self/environ', ${JSON.stringify(`${own}/env.txt`)})
os.symlink(${JSON.stringify(`${bDir}/secret.csv`)}, ${JSON.stringify(`${own}/other.csv`)})
print('planted')` })
    rows.push(['python planted the links', planted.includes('planted'), true])
    rows.push(['marker link: target untouched', cat(bait), 'BAIT'])
    for (const [label, path] of [['/proc/self/environ link', 'env.txt'], ["B's file link", 'other.csv']]) {
      const result = await canvas({ id: 'leak', kind: 'file', path: `${own}/${path}` })
      rows.push([`${label}: refused`, /no file at|outside this session's workspace/.test(result), true])
      rows.push([`${label}: nothing leaked`, leaked(result), false])
    }
    // a real file: read (with the strict runner: by the sandboxed cat) and written as v1
    const first = await canvas({ id: 'r', kind: 'markdown', path: `${own}/real.md` })
    rows.push(['real file → v1', /canvas-r-v1\.md/.test(first), true])
    rows.push(['v1 holds the real file', cat(`${own}/canvas-r-v1.md`), '# real report'])

    // C2, write: python swaps this chat's output folder for a link to B's folder
    dx('sh', '-c', `mv ${own} ${own}.moved && ln -s ${bDir} ${own}`)
    const second = await canvas({ id: 'r', kind: 'markdown', content: 'WRITTEN-BY-A' })
    rows.push(['write through a linked output folder: refused', /isError":true/.test(second), true])
    // the end-of-turn reconcile moves stray files into generated/<this chat>/ — now a link to B's folder
    dx('sh', '-c', `printf STRAY > ${pDir}/stray.txt`)
    await call('python', { code: 'print(1)' })
    rows.push(["nothing moved or written into B's folder", dx('ls', bDir).trim(), 'secret.csv'])
    cp.close()
    rows.push(["no secret in A's project folder", dx('sh', '-c', `grep -rlE 'B-SECRET|OPENAI_API_KEY|FOX_INTERNAL_SECRET' ${pDir}.moved ${own}.moved 2>/dev/null || true`).trim(), ''])

    // layer 2 on its own: the sandboxed cat the canvas uses cannot follow a link out of the folder
    const runner = '/repo/docker/fox-confine.sh'
    const direct = dx('sh', '-c', `${runner} --ro-bind / / --bind ${pDir} ${pDir} -- /usr/bin/cat -- ${own}.moved/other.csv 2>&1; echo "exit=$?"`)
    rows.push(['sandboxed cat of a link: fails', /exit=0/.test(direct) || direct.includes('B-SECRET'), false])
    rows.push(['sandboxed cat of a real file', cat(`${own}.moved/real.md`) === '# real report' ? dx('sh', '-c', `${runner} --ro-bind / / --bind ${pDir} ${pDir} -- /usr/bin/cat -- ${own}.moved/real.md`) : '(no real.md)', '# real report'])

    const bad = rows.filter(([, got, want]) => got !== want)
    return { ok: bad.length === 0, detail: bad.length ? `FAILED: ${bad.map(([l, g, w]) => `${l}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`).join('; ')}` : `${rows.length} checks` }
  },
}

const only = process.argv.slice(2)
let failed = 0
for (const name of Object.keys(tests).filter((n) => only.length === 0 || only.includes(n))) {
  try {
    const { ok, detail } = await tests[name]()
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
    if (!ok) failed += 1
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}  threw: ${error instanceof Error ? error.message : error}`)
  }
}
console.log(failed === 0 ? '\nALL E2E TESTS PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
