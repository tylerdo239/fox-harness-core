#!/usr/bin/env node
// End-to-end test of the two-service deployment (docs/single-backend-architecture-plan.md): a real browser-facing
// path — nginx (web image) -> gateway -> the agent runtime(s) it started -> mock LLM — with two real users.
// Everything is driven over HTTP/WebSocket exactly as apps/web does; the only inspection of the backend's
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

/** One chat connection through the full path. `events` = snapshot + live events. */
function chat(token, { session = 'new', params = {} } = {}) {
  const query = new URLSearchParams({ token, ...params })
  const ws = new WebSocket(`${WS_BASE}/sessions/${session}?${query}`)
  const c = { ws, events: [], frames: [], errors: [], closed: false, status: undefined, sessionId: session === 'new' ? undefined : session }
  const waiters = []
  const notify = () => { for (const w of [...waiters]) w() }
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
  c.opened = new Promise((resolve) => { ws.once('open', () => resolve(true)); ws.once('error', () => resolve(false)); ws.once('unexpected-response', () => resolve(false)) })
  c.send = (text) => ws.send(JSON.stringify({ type: 'followup', text }))
  c.waitFor = (predicate, timeoutMs = 30000, label = 'condition') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${label}; errors=${JSON.stringify(c.errors)} status=${c.status}`)) }, timeoutMs)
    const check = () => { const hit = predicate(c); if (hit) { cleanup(); resolve(hit) } }
    const cleanup = () => { clearTimeout(timer); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1) }
    waiters.push(check); check()
  })
  c.ready = () => c.waitFor((x) => x.frames.some((f) => f.type === 'snapshot'), 30000, 'snapshot')
  c.turnEnds = (n, ms) => c.waitFor((x) => x.events.filter((e) => e.type === 'turn/end').length >= n, ms, `${n} turn/end`)
  c.close = () => { try { ws.close() } catch { /* already closed */ } }
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
    return { ok: !!ra && !!rb && rb.tools.length === 1 && rb.tools[0] === 'analyze_data' && ra.tools.length > 5 && rb.system.includes('Data Studio'), detail: `default tools=${ra?.tools.length}, data-studio tools=${JSON.stringify(rb?.tools)}` }
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

  // Two roles. user: chats + own data + Data Studio dashboards read-only. admin: everything (src/index.ts adminGate).
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
    // Data Studio: admin-only except reading dashboards
    for (const [method, path, body] of [
      ['GET', '/data-studio/sources'], ['PATCH', '/data-studio/sources/x', {}], ['GET', '/data-studio/glossary'],
      ['POST', '/data-studio/glossary', {}], ['GET', '/data-studio/metrics'], ['GET', '/data-studio/relationships'],
      ['POST', '/data-studio/dremio/sync', {}], ['POST', '/data-studio/dremio/browse', {}], ['PATCH', '/data-studio/entities/x', { allow_user: true }],
      ['PATCH', '/data-studio/charts/x', {}], ['POST', '/data-studio/dashboards', { title: 't' }], ['GET', '/data-studio/dashboards/meta/available-charts'],
    ]) await expect(`${method} ${path}, as user`, a.token, method, path, body, 403)
    const dashUser = await api('GET', '/data-studio/dashboards', a.token)
    rows.push(['GET dashboards, as user (read-only allowed)', dashUser.status === 403 ? 403 : 'not 403', 'not 403'])
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
    const logs = execFileSync('docker', ['logs', BACKEND], { encoding: 'utf8' })
    const roleOf = (id) => (logs.match(new RegExp(`"ws_connect","sessionId":"${id}"[^\\n]*"role":"(\\w+)"`)) ?? [])[1]
    const ru = roleOf(cu.sessionId), ra = roleOf(ca.sessionId)
    // an admin opening the USER's session still runs it with the owner's role
    const view = chat(adm, { session: cu.sessionId }); await view.opened; await view.ready(); await sleep(300)
    const logs2 = execFileSync('docker', ['logs', BACKEND], { encoding: 'utf8' })
    const viewRoles = [...logs2.matchAll(new RegExp(`"ws_connect","sessionId":"${cu.sessionId}"[^\\n]*"role":"(\\w+)"`, 'g'))].map((m) => m[1])
    cu.close(); ca.close(); view.close()
    return { ok: ru === 'user' && ra === 'admin' && viewRoles.every((r) => r === 'user'), detail: `user session role=${ru}, admin session role=${ra}, admin viewing the user's session -> ${JSON.stringify(viewRoles)}` }
  },

  // Model-run bash/python get their own network namespace (fox-confine.sh --unshare-net): measured before the fix,
  // confined code reached the gateway's Redis (login tokens) without a password, Mongo, MariaDB and the internet.
  async sandboxNoNetwork() {
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
