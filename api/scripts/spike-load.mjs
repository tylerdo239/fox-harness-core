#!/usr/bin/env node
// Spike measurements (docs/single-backend-architecture-plan.md §10): what does ONE runtime cost as the
// number of open sessions grows, how does it behave with many concurrent streams, and does idle
// disposal give the RAM back? Mock LLM streams 40 pieces x 50 ms (~2 s) for a prompt containing SLOW.
//
//   SPIKE_URL=ws://127.0.0.1:4002 SPIKE_DATA=... SPIKE_DATA_RUNTIME=... SPIKE_CONTAINER=spike-runtime \
//     node scripts/spike-load.mjs 50 200 500
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { connect, sleep, workspace, hostWorkspace } from './spike-single-runtime.mjs'

const CONTAINER = process.env.SPIKE_CONTAINER ?? 'spike-runtime'
const rssMb = () => Number(execSync(`docker exec ${CONTAINER} sh -c "grep VmRSS /proc/1/status"`).toString().replace(/\D+/g, '')) / 1024
const totalMb = () => { const m = execSync(`docker stats --no-stream --format '{{.MemUsage}}' ${CONTAINER}`).toString().split('/')[0].trim(); return m.endsWith('GiB') ? parseFloat(m) * 1024 : parseFloat(m) }
const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]
const fmt = (x) => x.toFixed(0)

const sizes = process.argv.slice(2).map(Number)
const clients = []
console.log(`runtime node RSS (empty): ${fmt(rssMb())} MB, container total ${fmt(totalMb())} MB`)

async function openBatch(from, to) {
  for (let i = from; i < to; i += 25) {
    const batch = []
    for (let j = i; j < Math.min(i + 25, to); j += 1) {
      mkdirSync(hostWorkspace(`load${j % 7}`, `s${j}`), { recursive: true })
      const c = connect(randomUUID(), { isNew: true, params: { flow: j % 3 === 0 ? 'data-analysis' : 'default', cwd: workspace(`load${j % 7}`, `s${j}`) } })
      clients.push(c)
      batch.push(c.opened.then(() => c.followup(`hello ${j}`)).then(() => c.waitTurnEnds(1, 120000)))
    }
    await Promise.all(batch)
  }
}

for (const n of sizes) {
  const t0 = Date.now()
  await openBatch(clients.length, n)
  const createMs = Date.now() - t0
  await sleep(1000)
  console.log(`\n[${n} sessions open] created in ${(createMs / 1000).toFixed(1)}s | node RSS ${fmt(rssMb())} MB | container ${fmt(totalMb())} MB`)

  // every open session streams at once (ideal wall time ~2.1 s each)
  const turnsBefore = clients.map((c) => c.events.filter((e) => e.type === 'turn/end').length)
  const t1 = Date.now()
  const done = clients.map((c, i) => { c.followup('SLOW stream'); return c.waitTurnEnds(turnsBefore[i] + 1, 180000).then(() => Date.now() - t1) })
  const durations = await Promise.all(done)
  console.log(`  ${clients.length} concurrent streams: ideal ~2100 ms | p50 ${fmt(pct(durations, 0.5))} ms, p95 ${fmt(pct(durations, 0.95))} ms, max ${fmt(Math.max(...durations))} ms`)
}

// idle disposal: close everything, wait past FOX_IDLE_DISPOSE_MS, RAM should fall
const before = rssMb()
for (const c of clients) c.close()
await sleep(Number(process.env.SPIKE_WAIT_MS ?? 25000))
const logs = execSync(`docker logs ${CONTAINER} 2>&1 | grep -c session_disposed_idle || true`).toString().trim()
console.log(`\nafter closing all and waiting: node RSS ${fmt(before)} -> ${fmt(rssMb())} MB, container ${fmt(totalMb())} MB, session_disposed_idle logged ${logs}x`)
const t2 = Date.now()
const r = connect(clients[0].frames.find((f) => f.type === 'session')?.sessionId ?? '', { params: { flow: 'data-analysis', cwd: workspace('load0', 's0') } })
await r.opened; await r.waitFor((x) => x.frames.some((f) => f.type === 'snapshot'), 30000, 'resume')
console.log(`resume of a disposed session: ${Date.now() - t2} ms, ${r.events.length} events replayed`)
r.close()
