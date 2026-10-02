#!/usr/bin/env node
// Spike harness (docs/single-backend-architecture-plan.md, giai đoạn 0).
// Drives ONE running dsh runtime (packages/transport on SPIKE_URL) the way the
// gateway would, with the mock LLM (scripts/mock-llm.mjs) behind it, and
// prints a pass/fail table. Start the mock + runtime first (see the plan).
//
//   SPIKE_URL=ws://127.0.0.1:4001 MOCK=http://127.0.0.1:4999 node scripts/spike-single-runtime.mjs [testName...]

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const BASE = process.env.SPIKE_URL ?? 'ws://127.0.0.1:4001'
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:4999'
const SECRET = process.env.SPIKE_INTERNAL_SECRET ?? 'spike-secret'
// DATA = where THIS script creates files; DATA_RT = the same directory as the runtime sees it
// (differs when the runtime runs in a container with the data dir bind-mounted).
export const DATA = process.env.SPIKE_DATA ?? '/tmp/spike-data'
export const DATA_RT = process.env.SPIKE_DATA_RUNTIME ?? DATA

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One session connection. `events` = snapshot + live, in arrival order. */
export function connect(sessionId, { isNew = false, params = {} } = {}) {
  const query = new URLSearchParams(params)
  if (isNew) query.set('id', sessionId)
  const path = isNew ? 'new' : sessionId
  const ws = new WebSocket(`${BASE}/sessions/${path}?${query}`, { headers: SECRET ? { 'x-fox-harness-internal-secret': SECRET } : {} })
  const client = { ws, events: [], frames: [], errors: [], closed: false }
  const waiters = []
  const notify = () => { for (const w of [...waiters]) w() }
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    client.frames.push(frame)
    if (frame.type === 'snapshot') client.events.push(...frame.events)
    else if (frame.type === 'event') client.events.push(frame.event)
    else if (frame.type === 'error') client.errors.push(frame.message)
    notify()
  })
  ws.on('close', () => { client.closed = true; notify() })
  ws.on('error', (error) => { client.errors.push(String(error)); notify() })
  client.opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  client.send = (frame) => ws.send(JSON.stringify(frame))
  client.followup = (text) => client.send({ type: 'followup', text })
  client.waitFor = (predicate, timeoutMs = 20000, label = 'condition') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${label}; errors=${JSON.stringify(client.errors)}`)) }, timeoutMs)
    const check = () => { const hit = predicate(client); if (hit) { cleanup(); resolve(hit) } }
    const cleanup = () => { clearTimeout(timer); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1) }
    waiters.push(check)
    check()
  })
  /** Resolves when `n` `turn/end` events have been seen (counts snapshot too). */
  client.waitTurnEnds = (n, timeoutMs) => client.waitFor((c) => c.events.filter((e) => e.type === 'turn/end').length >= n, timeoutMs, `${n} turn/end`)
  client.close = () => { try { ws.close() } catch { /* already closed */ } }
  return client
}

export async function mockRequests() { return (await fetch(`${MOCK}/_requests`)).json() }
export async function clearMock() { await fetch(`${MOCK}/_requests`, { method: 'DELETE' }) }
export const turnsOf = (events, type) => events.filter((e) => e.type === type).map((e) => e.data?.turn)
export const lastText = (events) => {
  const msg = [...events].reverse().find((e) => e.type === 'assistant/message')
  return (msg?.data?.message?.content ?? []).map((b) => b.text ?? '').join('')
}

// Distinct per-user workspace dirs, as the gateway would assign (`<data>/<userId>/<sessionId>`).
export function workspace(user, sessionId) { return `${DATA_RT}/${user}/${sessionId}` }
export function hostWorkspace(user, sessionId) { return `${DATA}/${user}/${sessionId}` }

const tests = {
  // T1: a plain turn works through the patched (scoped) driver.
  async baseline() {
    const id = randomUUID()
    const c = connect(id, { isNew: true })
    await c.opened
    await c.waitFor((x) => x.frames.some((f) => f.type === 'snapshot'), 15000, 'snapshot')
    c.followup('hello')
    await c.waitTurnEnds(1)
    const end = c.events.find((e) => e.type === 'turn/end')
    c.close()
    return { ok: end?.data?.reason?.kind === 'completed' && lastText(c.events) === 'OK', detail: `reason=${end?.data?.reason?.kind} text=${lastText(c.events)}` }
  },

  // T2: after a reconnect (agent already live) AND after a real resume, turn numbers keep counting.
  async turnNumbering() {
    const id = randomUUID()
    const a = connect(id, { isNew: true })
    await a.opened
    a.followup('one')
    await a.waitTurnEnds(1)
    a.close()
    await sleep(200)
    const b = connect(id)
    await b.opened
    await b.waitFor((x) => x.frames.some((f) => f.type === 'snapshot'), 15000, 'snapshot')
    b.followup('two')
    await b.waitTurnEnds(2)
    const turns = turnsOf(b.events, 'turn/start')
    b.close()
    return { ok: JSON.stringify(turns) === '[1,2]', detail: `turn/start sequence=${JSON.stringify(turns)}` }
  },

  // T3: two sessions of DIFFERENT flows in the SAME process get different tools + persona.
  async presetsDiffer() {
    await clearMock()
    const a = connect(randomUUID(), { isNew: true, params: { flow: 'default', cwd: workspace('userA', 'sa') } })
    const b = connect(randomUUID(), { isNew: true, params: { flow: 'data-studio', cwd: workspace('userB', 'sb') } })
    await Promise.all([a.opened, b.opened])
    a.followup('MARK-A hello')
    b.followup('MARK-B hello')
    await Promise.all([a.waitTurnEnds(1), b.waitTurnEnds(1)])
    const reqs = await mockRequests()
    const ra = reqs.find((r) => r.lastUser.startsWith('MARK-A'))
    const rb = reqs.find((r) => r.lastUser.startsWith('MARK-B'))
    a.close(); b.close()
    if (!ra || !rb) return { ok: false, detail: `missing mock requests a=${!!ra} b=${!!rb} errors=${JSON.stringify([...a.errors, ...b.errors])}` }
    const okTools = rb.tools.length === 1 && rb.tools[0] === 'analyze_data' && ra.tools.length > 1 && !ra.tools.includes('analyze_data')
    const okPersona = ra.system.includes('Fox Harness') && !ra.system.includes('Data Studio') && rb.system.includes('Data Studio')
    return { ok: okTools && okPersona, detail: `A tools=${ra.tools.length}(${ra.tools.slice(0, 4)}...) B tools=${JSON.stringify(rb.tools)} personaOK=${okPersona}` }
  },

  // T4 (the go/no-go one): user A's agent tries to reach user B's files and host files outside A's
  // workspace, through every model-facing tool. Each vector reports LEAK/blocked.
  async crossUserRead() {
    const secretB = `${workspace('userB', 'sb')}/secret.txt`
    const canary = `${DATA_RT}/canary-outside.txt`
    mkdirSync(hostWorkspace('userB', 'sb'), { recursive: true })
    mkdirSync(hostWorkspace('userA', 'sa'), { recursive: true })
    writeFileSync(`${hostWorkspace('userB', 'sb')}/secret.txt`, 'SECRET-B-CANARY')
    writeFileSync(`${DATA}/canary-outside.txt`, 'HOSTFILE-CANARY')
    rmSync(`${hostWorkspace('userB', 'sb')}/pwned.txt`, { force: true })
    writeFileSync(`${hostWorkspace('userA', 'sa')}/own.txt`, 'OWN-FILE-CONTENT')
    const vectors = [
      ['CONTROL read own file (must succeed)', 'read', { file_path: `${workspace('userA', 'sa')}/own.txt` }, 'OWN-FILE-CONTENT'],
      ['CONTROL read own file, relative (must succeed)', 'read', { file_path: 'own.txt' }, 'OWN-FILE-CONTENT'],
      ['CONTROL read bundled skill file (must succeed)', 'read', { file_path: '/repo/packages/skills/web-research/SKILL.md' }, 'name:'],
      ['CONTROL bash cat bundled skill file (must succeed)', 'bash', { command: 'cat /repo/packages/skills/web-research/SKILL.md', description: 'cat' }, 'name:'],
      ['read abs (other user)', 'read', { file_path: secretB }, 'SECRET-B-CANARY'],
      ['read ../ (other user)', 'read', { file_path: '../../userB/sb/secret.txt' }, 'SECRET-B-CANARY'],
      ['read host file', 'read', { file_path: canary }, 'HOSTFILE-CANARY'],
      ['glob other user', 'glob', { pattern: '**/*.txt', path: workspace('userB', 'sb') }, 'secret.txt'],
      ['grep other user', 'grep', { pattern: 'SECRET-B', path: DATA_RT, output_mode: 'content' }, 'SECRET-B-CANARY'],
      ['CONTROL bash cat own file (must succeed)', 'bash', { command: `cat ${workspace('userA', 'sa')}/own.txt`, description: 'cat' }, 'OWN-FILE-CONTENT'],
      ['CONTROL bash write+read own workspace (must succeed)', 'bash', { command: `echo OWN-WRITE-OK > w.txt && cat w.txt`, description: 'w' }, 'OWN-WRITE-OK'],
      // MONGODB_URL (set on the runtime as a canary) is NOT matched by dsh's own env scrub (KEY|PASSWORD|SECRET|TOKEN).
      ['bash `env` shows MONGODB_URL canary', 'bash', { command: 'env', description: 'env' }, 'spike-pw'],
      ['bash /proc/1/environ shows MONGODB_URL canary', 'bash', { command: `cat /proc/1/environ | tr '\\0' '\\n'`, description: 'p' }, 'spike-pw'],
      ['bash /proc/self/environ shows MONGODB_URL canary', 'bash', { command: `cat /proc/self/environ | tr '\\0' '\\n'`, description: 'p' }, 'spike-pw'],
      ['bash ls /repo (source tree: services/, package.json)', 'bash', { command: 'ls /repo /repo/packages', description: 'ls' }, 'services'],
      ['bash ls /repo/packages (other packages)', 'bash', { command: 'ls /repo/packages', description: 'ls' }, 'transport'],
      ['bash ls data root (all users)', 'bash', { command: `ls ${DATA_RT}`, description: 'ls' }, 'userB'],
      ['bash cat other user', 'bash', { command: `cat ${secretB}`, description: 'cat' }, 'SECRET-B-CANARY'],
      ['bash cat host file', 'bash', { command: `cat ${canary}`, description: 'cat' }, 'HOSTFILE-CANARY'],
      ['str_replace_editor view', 'str_replace_editor', { command: 'view', path: secretB }, 'SECRET-B-CANARY'],
    ]
    const rows = []
    for (const [label, tool, args, marker] of vectors) {
      const c = connect(randomUUID(), { isNew: true, params: { flow: 'default', cwd: workspace('userA', 'sa') } })
      await c.opened
      c.followup(`CALL ${tool} ${JSON.stringify(args)}`)
      let outcome
      try {
        await c.waitTurnEnds(1, 30000)
        const result = c.events.filter((e) => e.type === 'tool/result').map((e) => JSON.stringify(e.data.message?.content ?? '')).join(' ')
        const texts = [...result.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join(' | ')
        outcome = result.includes(marker) ? 'LEAK' : `blocked (${texts.slice(0, 110)})`
      } catch (error) {
        outcome = `no result (${error.message.slice(0, 60)})`
      }
      c.close()
      const control = label.startsWith('CONTROL')
      // a control PASSES by returning its marker; every other vector passes by NOT returning it
      const bad = control ? !outcome.startsWith('LEAK') : outcome.startsWith('LEAK')
      rows.push(`${bad ? (control ? 'FAILED ' : 'LEAK   ') : (control ? 'ok     ' : 'blocked')}  ${label}${control && !bad ? '' : (outcome.startsWith('LEAK') ? '' : '  -> ' + outcome)}`)
    }
    // symlink escape: bash (confined) plants a symlink inside A's workspace pointing at B's; the in-process
    // `read` tool (NOT confined by bwrap) must not follow it out.
    {
      const c = connect(randomUUID(), { isNew: true, params: { flow: 'default', cwd: workspace('userA', 'sa') } })
      await c.opened
      c.followup(`CALL bash ${JSON.stringify({ command: `ln -sfn ${workspace('userB', 'sb')} ${workspace('userA', 'sa')}/linkB`, description: 'ln' })}`)
      await c.waitTurnEnds(1, 30000).catch(() => {})
      c.followup(`CALL read ${JSON.stringify({ file_path: `${workspace('userA', 'sa')}/linkB/secret.txt` })}`)
      await c.waitTurnEnds(2, 30000).catch(() => {})
      const leaked = JSON.stringify(c.events.filter((e) => e.type === 'tool/result').map((e) => e.data.message?.content)).includes('SECRET-B-CANARY')
      c.close()
      rows.push(`${leaked ? 'LEAK   ' : 'blocked'}  symlink planted by bash, followed by in-process read`)
    }
    // write vector: judged on disk, not on the tool's reply.
    const w = connect(randomUUID(), { isNew: true, params: { flow: 'default', cwd: workspace('userA', 'sa') } })
    await w.opened
    w.followup(`CALL write ${JSON.stringify({ file_path: `${workspace('userB', 'sb')}/pwned.txt`, content: 'x' })}`)
    await w.waitTurnEnds(1, 30000).catch(() => {})
    w.close()
    rows.push(`${existsSync(`${hostWorkspace('userB', 'sb')}/pwned.txt`) ? 'LEAK   ' : 'blocked'}  write into other user's dir`)
    const leaks = rows.filter((r) => r.startsWith('LEAK') || r.startsWith('FAILED')).length
    return { ok: leaks === 0, detail: `${leaks} leak(s) of ${rows.length}\n      ` + rows.join('\n      ') }
  },

  // T5: the python tool is per CONVERSATION and confined to the conversation's workspace.
  async pythonIsolation() {
    const mk = (user, sid) => connect(randomUUID(), { isNew: true, params: { flow: 'data-analysis', cwd: workspace(user, sid) } })
    mkdirSync(hostWorkspace('userA', 'pa'), { recursive: true })
    mkdirSync(hostWorkspace('userB', 'pb'), { recursive: true })
    writeFileSync(`${hostWorkspace('userB', 'pb')}/secret.txt`, 'SECRET-B-CANARY')
    const run = async (c, code, turnNo) => {
      c.followup(`CALL python ${JSON.stringify({ code })}`)
      await c.waitTurnEnds(turnNo, 60000)
      const results = c.events.filter((e) => e.type === 'tool/result')
      return JSON.stringify(results[results.length - 1]?.data.message?.content ?? '')
    }
    const a = mk('userA', 'pa')
    const b = mk('userB', 'pb')
    await Promise.all([a.opened, b.opened])
    const rows = []
    const check = (label, ok, extra = '') => rows.push(`${ok ? 'ok     ' : 'FAILED '} ${label}${extra ? '  -> ' + extra : ''}`)
    // concurrent cells in two sessions: neither may hang or take the other's answer
    const [ra, rb] = await Promise.all([run(a, 'import time\nx = 41\ntime.sleep(2)\nprint("A-DONE", x)', 1), run(b, 'import time\ntime.sleep(2)\nprint("B-DONE")', 1)])
    check('two sessions run python concurrently, each gets its own output', ra.includes('A-DONE 41') && !ra.includes('B-DONE') && rb.includes('B-DONE') && !rb.includes('A-DONE'))
    const rb2 = await run(b, 'print(x)', 2)
    check("B cannot see A's variable x (separate kernels)", rb2.includes('NameError') || rb2.includes('not defined'), rb2.slice(0, 80))
    const ra2 = await run(a, 'print(x + 1)', 2)
    check("A still has its own variable x", ra2.includes('42'))
    const rleak = await run(a, `print(open(${JSON.stringify(workspace('userB', 'pb') + '/secret.txt')}).read())`, 3)
    check("A's python cannot read B's file", !rleak.includes('SECRET-B-CANARY'), rleak.slice(0, 100))
    const renv = await run(a, 'import os; print("MONGO=" + str(os.environ.get("MONGODB_URL")))', 4)
    check("python env has no runtime MONGODB_URL", !renv.includes('spike-pw'), renv.slice(0, 80))
    const rls = await run(a, `import os; print(sorted(os.listdir("${DATA_RT}")))`, 5)
    check("python cannot list the data root (other users)", !rls.includes('userB'), rls.slice(0, 100))
    // a cell over the limit is interrupted, and the conversation's variables survive it
    const rt = await run(a, 'import time\ntime.sleep(120)', 6)
    check('over-limit cell is stopped with the "variables still in memory" message', rt.includes('stopped after') || rt.includes('did not stop'), rt.slice(0, 120))
    const rafter = await run(a, 'print("x is", x)', 7)
    check('variables survive the interrupt (SIGINT reaches python through bwrap)', rafter.includes('x is 41'), rafter.slice(0, 100))
    a.close(); b.close()
    const bad = rows.filter((r) => r.startsWith('FAILED')).length
    return { ok: bad === 0, detail: `${bad} failed of ${rows.length}\n      ` + rows.join('\n      ') }
  },

  // T6: per-user skills — a skill in A's workspace reaches A's catalog and nobody else's.
  async skillsPerUser() {
    const skill = (user, sid, name) => {
      const dir = `${hostWorkspace(user, sid)}/.dsh/skills/${name}`
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/SKILL.md`, `---\nname: ${name}\ndescription: "spike skill ${name}"\n---\n\nBody of ${name}.\n`)
    }
    skill('userA', 'ka', 'only-a-skill')
    skill('userB', 'kb', 'only-b-skill')
    await clearMock()
    const a = connect(randomUUID(), { isNew: true, params: { flow: 'default', cwd: workspace('userA', 'ka') } })
    const b = connect(randomUUID(), { isNew: true, params: { flow: 'default', cwd: workspace('userB', 'kb') } })
    await Promise.all([a.opened, b.opened])
    a.followup('MARK-KA hello'); b.followup('MARK-KB hello')
    await Promise.all([a.waitTurnEnds(1), b.waitTurnEnds(1)])
    const reqs = await mockRequests()
    a.close(); b.close()
    const ra = reqs.find((r) => r.lastUser.startsWith('MARK-KA'))
    const rb = reqs.find((r) => r.lastUser.startsWith('MARK-KB'))
    if (!ra || !rb) return { ok: false, detail: 'missing mock requests' }
    const ok = ra.skills.includes('only-a-skill') && !ra.skills.includes('only-b-skill') && rb.skills.includes('only-b-skill') && !rb.skills.includes('only-a-skill')
    return { ok, detail: `A sees [${ra.skills.join(', ')}]\n      B sees [${rb.skills.join(', ')}]` }
  },
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv.slice(2)
  const names = Object.keys(tests).filter((n) => only.length === 0 || only.includes(n))
  let failed = 0
  for (const name of names) {
    try {
      const { ok, detail } = await tests[name]()
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
      if (!ok) failed += 1
    } catch (error) {
      failed += 1
      console.log(`FAIL  ${name}  threw: ${error instanceof Error ? error.message : error}`)
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}
