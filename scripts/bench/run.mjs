#!/usr/bin/env node
// Fixed benchmark for the data-analysis flow (docs/bench.md).
//
// Why this exists: every measurement before this one lived in a throwaway
// scratch directory, so "did that harness change help?" was answered from
// memory. This runs a fixed set of questions with known answers against the
// REAL stack — gateway, orchestrator, a worker container per case, the real
// model — and writes a report the next run can be compared against.
//
// The questions are NOT invented here: they are sampled from
// InfiAgent-DABench (github.com/InfiAgent/InfiAgent, da-dev split), whose
// answers are exact values, so grading is arithmetic, not another model's
// opinion. cases/ holds one JSON per question, fixtures/ the CSV it reads.
//
// Usage (the stack must already be up — this script never builds or deploys):
//   FOX_BENCH_EMAIL=... FOX_BENCH_PASSWORD=... node scripts/bench/run.mjs
//   node scripts/bench/run.mjs --suite full --repeat 3
//   node scripts/bench/run.mjs --baseline scripts/bench/reports/<file>.json
//
// Deliberately sequential: one chat is one Docker container, and this host
// caps concurrent containers (fs.inotify.max_user_instances). Running cases
// in parallel would measure the host, not the harness.

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.FOX_BENCH_URL ?? 'http://localhost:4000'
const EMAIL = process.env.FOX_BENCH_EMAIL
const PASSWORD = process.env.FOX_BENCH_PASSWORD

function parseArgs(argv) {
  const args = { suite: 'smoke', repeat: 1, only: undefined, baseline: undefined, out: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--suite') args.suite = argv[++i]
    else if (flag === '--repeat') args.repeat = Number(argv[++i])
    else if (flag === '--only') args.only = new Set(argv[++i].split(','))
    else if (flag === '--baseline') args.baseline = argv[++i]
    else if (flag === '--out') args.out = argv[++i]
    else throw new Error(`unknown flag ${flag}`)
  }
  return args
}

async function api(token, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> HTTP ${res.status} ${await res.text()}`)
  return res
}

async function login() {
  if (!EMAIL || !PASSWORD) throw new Error('set FOX_BENCH_EMAIL and FOX_BENCH_PASSWORD (see docs/bench.md)')
  const res = await api(undefined, '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  return (await res.json()).token
}

// One case = one fresh project (its own working directory, its own uploaded
// CSV) and one fresh chat in it, so nothing a previous case wrote can be read
// by the next one. FOX_BENCH_KEEP=1 leaves the projects behind for inspection.
async function runCase(token, testCase, run) {
  const started = Date.now()
  const project = await (
    await api(token, '/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `bench ${testCase.id} #${run}` }),
    })
  ).json()
  const projectId = project.projectId ?? project.id
  try {
    for (const fixture of testCase.fixtures ?? [testCase.fixture]) {
      await api(token, `/projects/${projectId}/files?name=${encodeURIComponent(fixture)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: await readFile(join(HERE, 'fixtures', fixture)),
      })
    }
    const transcript = await ask(token, projectId, testCase, started)
    // What the chat wrote: everything in its own output folder (services/orchestrator's
    // workspace-files.ts marks those `origin: 'chat'`).
    const listed = await (await api(token, `/projects/${projectId}/files`)).json()
    const filesWritten = (listed.files ?? []).filter((file) => file.origin === 'chat').map((file) => file.path)
    // A chat's file with no chat attached to it: the UI cannot tell whose it is, so it shows it in
    // every chat of the project. This must always be empty.
    const filesUnowned = (listed.files ?? [])
      .filter((file) => file.origin === 'chat' && !file.sessionId)
      .map((file) => file.path)
    return { ...transcript, filesWritten, filesUnowned, seconds: transcript.seconds ?? (Date.now() - started) / 1000 }
  } finally {
    if (!process.env.FOX_BENCH_KEEP) await api(token, `/projects/${projectId}`, { method: 'DELETE' }).catch(() => {})
  }
}

// Speaks the same WebSocket protocol as the browser (packages/transport/src/server.ts):
// `{type:'session'}` on connect, `{type:'event'}` per session event, and the
// client sends `{type:'followup'}`. Resolves at `turn/end`.
function ask(token, projectId, testCase, started) {
  const url = `${BASE.replace(/^http/, 'ws')}/sessions/new?project=${projectId}&token=${encodeURIComponent(token)}`
  const timeoutCheck = testCase.checks.find((check) => check.kind === 'maxSeconds')
  const hardLimitMs = ((timeoutCheck?.value ?? 600) + 120) * 1000
  // A case is one message, or several sent in order — one turn each, the way a person types them.
  const prompts = testCase.prompts ?? [testCase.prompt]
  let sent = 0
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const transcript = { answerText: '', steps: 0, toolCalls: [], toolErrors: [], unknownTools: [], endReason: undefined, turns: [] }
    let turn = { steps: 0, toolCalls: [], answerText: '', outputs: [] }
    const timer = setTimeout(() => {
      transcript.endReason = 'timeout'
      ws.close()
      resolve(transcript)
    }, hardLimitMs)
    const finish = (value) => {
      clearTimeout(timer)
      ws.close()
      resolve(value)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`websocket failed for ${testCase.id}`))
    }
    ws.onmessage = (message) => {
      const frame = JSON.parse(message.data)
      if (frame.type === 'session') {
        ws.send(JSON.stringify({ type: 'followup', text: prompts[sent++] }))
        return
      }
      if (frame.type === 'error') {
        transcript.endReason = `transport: ${frame.message}`
        finish(transcript)
        return
      }
      if (frame.type !== 'event') return
      const { type, data } = frame.event
      if (type === 'assistant/message') {
        transcript.steps += 1
        const text = (data.message.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        if (text.trim()) {
          transcript.answerText = text
          turn.answerText = text
        }
        turn.steps += 1
      } else if (type === 'tool/call') {
        transcript.toolCalls.push(data.name)
        turn.toolCalls.push(data.name)
      } else if (type === 'tool/result') {
        turn.outputs.push({ text: errorText(data, 20000), isError: Boolean(data.error) })
        if (data.error) {
          transcript.toolErrors.push(`${data.error.code ?? 'ERROR'}: ${errorText(data)}`)
          if (data.error.code === 'UNKNOWN_TOOL') transcript.unknownTools.push(errorText(data))
        }
      } else if (type === 'turn/end') {
        transcript.endReason = data.reason.kind
        transcript.turns.push(turn)
        turn = { steps: 0, toolCalls: [], answerText: '', outputs: [] }
        transcript.seconds = (Date.now() - started) / 1000
        if (data.reason.kind === 'completed' && sent < prompts.length) {
          ws.send(JSON.stringify({ type: 'followup', text: prompts[sent++] }))
          return
        }
        finish(transcript)
      }
    }
  })
}

function errorText(data, limit = 200) {
  const block = data.message?.content?.[0]
  const blocks = block?.content ?? data.message?.content ?? []
  return blocks
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .slice(0, limit)
}

// Answers arrive as `@name[value]`, the format each prompt asks for — but the model drops the
// brackets often enough (`@so_xe0`, `@392`) to decide cases that are really about something else.
// The name is fixed by the case, so grading anchors on it: the bracketed form first, then `: value`,
// then a bare value. Leniency about the punctuation only, never about the value.
// One rule this puts on a case: no answer name may be a prefix of another in the same case.
function readAnswer(text, name) {
  // Diacritics are stripped from BOTH sides first: the model writes the field name back in
  // Vietnamese spelling often enough (`@thay_doi_phan_trăm` for `thay_doi_phan_tram`) to decide a
  // case whose answer was right in the same sentence.
  text = stripDiacritics(text)
  name = stripDiacritics(name)
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const pattern of [`@${escaped}\\s*\\[([^\\]]*)\\]`, `@${escaped}\\s*:\\s*([^\\s,;\\]]+)`, `@${escaped}\\s*([^\\s,;\\]]*)`]) {
    const match = new RegExp(pattern).exec(text)
    if (match !== null && match[1].trim() !== '') return match[1].trim()
  }
  return undefined
}

// Vietnamese answers come back with or without diacritics depending on the run ("Không" vs the
// "Khong" the prompt asks for), and that is not what any case is measuring.
function stripDiacritics(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
}

function normalize(text) {
  return stripDiacritics(text)
    .toLowerCase()
    .replace(/['"]+/g, '')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
}

function grade(testCase, transcript) {
  return testCase.checks.map((check) => {
    switch (check.kind) {
      case 'answer': {
        const raw = readAnswer(transcript.answerText, check.name)
        if (raw === undefined) return { check: `answer:${check.name}`, ok: false, detail: 'không có trong câu trả lời' }
        if (check.text !== undefined) {
          const ok = normalize(raw) === normalize(check.text)
          return { check: `answer:${check.name}`, ok, detail: `${raw} (đúng: ${check.text})` }
        }
        const got = Number(raw.replace(/[^\d.eE+-]/g, ''))
        const ok = Number.isFinite(got) && Math.abs(got - check.value) <= check.tolerance
        return { check: `answer:${check.name}`, ok, detail: `${raw} (đúng: ${check.value} ±${check.tolerance})` }
      }
      case 'mustContain': {
        const ok = new RegExp(check.pattern, 'i').test(transcript.answerText)
        return { check: `mustContain:${check.pattern}`, ok, detail: ok ? '' : 'không thấy trong câu trả lời' }
      }
      case 'mustNotContain': {
        const found = new RegExp(check.pattern, 'i').exec(transcript.answerText)
        return { check: `mustNotContain:${check.pattern}`, ok: found === null, detail: found ? `có "${found[0]}"` : '' }
      }
      case 'turnUsedTool': {
        // A multi-turn case rests on an earlier turn actually happening. When the model answers
        // "done" without calling anything (measured 2026-09-16: it did exactly that twice), every
        // later check fails for a reason that has nothing to do with what the case measures — so
        // name that premise as its own check instead of leaving it to be dug out of the log.
        const turn = transcript.turns?.[check.turn - 1]
        const used = (turn?.toolCalls ?? []).includes(check.name)
        return { check: `turnUsedTool:${check.turn}:${check.name}`, ok: used, detail: used ? '' : 'lượt đó không chạy gì' }
      }
      case 'lastTurnToolNotUsed': {
        const last = transcript.turns?.[transcript.turns.length - 1]
        const used = (last?.toolCalls ?? []).filter((name) => name === check.name)
        return { check: `lastTurnToolNotUsed:${check.name}`, ok: used.length === 0, detail: `lượt cuối gọi ${used.length} lần` }
      }
      case 'toolNotUsed': {
        const used = transcript.toolCalls.filter((name) => name === check.name)
        return { check: `toolNotUsed:${check.name}`, ok: used.length === 0, detail: `gọi ${used.length} lần` }
      }
      case 'noUnownedFiles': {
        const unowned = transcript.filesUnowned ?? []
        return { check: 'noUnownedFiles', ok: unowned.length === 0, detail: unowned.join(', ') }
      }
      case 'filesWrittenAtMost': {
        const written = transcript.filesWritten ?? []
        return {
          check: 'filesWrittenAtMost',
          ok: written.length <= check.value,
          detail: written.length === 0 ? 'không tạo file' : written.join(', '),
        }
      }
      case 'noUnknownTool':
        return { check: 'noUnknownTool', ok: transcript.unknownTools.length === 0, detail: transcript.unknownTools.join(' | ') }
      case 'toolErrorsAtMost':
        return {
          check: 'toolErrorsAtMost',
          ok: transcript.toolErrors.length <= check.value,
          detail: `${transcript.toolErrors.length} lỗi công cụ`,
        }
      case 'maxSteps':
        return { check: 'maxSteps', ok: transcript.steps <= check.value, detail: `${transcript.steps} bước` }
      case 'maxSeconds':
        return { check: 'maxSeconds', ok: transcript.seconds <= check.value, detail: `${transcript.seconds.toFixed(0)}s` }
      default:
        return { check: check.kind, ok: false, detail: 'loại kiểm tra chưa hỗ trợ' }
    }
  })
}

async function loadCases(args) {
  const files = (await readdir(join(HERE, 'cases'))).filter((name) => name.endsWith('.json')).sort()
  const cases = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(HERE, 'cases', name), 'utf-8'))))
  return cases.filter((testCase) =>
    args.only ? args.only.has(testCase.id) : args.suite === 'full' || testCase.suite === args.suite,
  )
}

function summarize(results) {
  const byCase = new Map()
  for (const result of results) {
    const entry = byCase.get(result.id) ?? { id: result.id, runs: 0, passed: 0, steps: [], seconds: [], toolErrors: [] }
    entry.runs += 1
    if (result.pass) entry.passed += 1
    entry.steps.push(result.steps)
    entry.seconds.push(result.seconds)
    entry.toolErrors.push(result.toolErrors.length)
    byCase.set(result.id, entry)
  }
  return [...byCase.values()]
}

const mean = (list) => (list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length)

async function main() {
  // The repo needs Node 22+ anyway (package.json engines); say so here, because on
  // Node 20 the only symptom is "WebSocket is not defined" in the middle of a case.
  if (typeof WebSocket === 'undefined') throw new Error('cần Node 22 trở lên (global WebSocket)')
  const args = parseArgs(process.argv.slice(2))
  const cases = await loadCases(args)
  if (cases.length === 0) throw new Error('no cases selected')
  const token = await login()
  console.log(`bench: ${cases.length} bài x ${args.repeat} lần, suite=${args.suite}, ${BASE}\n`)

  const results = []
  for (let run = 1; run <= args.repeat; run += 1) {
    for (const testCase of cases) {
      process.stdout.write(`  ${testCase.id} (lần ${run}) ... `)
      let transcript
      try {
        transcript = await runCase(token, testCase, run)
      } catch (error) {
        console.log(`LỖI CHẠY: ${error.message}`)
        results.push({ id: testCase.id, run, pass: false, steps: 0, seconds: 0, toolErrors: [], checks: [], crash: String(error) })
        continue
      }
      const checks = grade(testCase, transcript)
      const pass = checks.every((check) => check.ok)
      results.push({
        id: testCase.id,
        run,
        pass,
        steps: transcript.steps,
        seconds: transcript.seconds,
        toolErrors: transcript.toolErrors,
        unknownTools: transcript.unknownTools,
        filesWritten: transcript.filesWritten,
        filesUnowned: transcript.filesUnowned,
        turns: transcript.turns,
        endReason: transcript.endReason,
        answerText: transcript.answerText.slice(-600),
        checks,
      })
      const failed = checks.filter((check) => !check.ok)
      console.log(
        pass
          ? `ĐỖ (${transcript.steps} bước, ${transcript.seconds.toFixed(0)}s)`
          : `RỚT — ${failed.map((check) => `${check.check}: ${check.detail}`).join('; ')}`,
      )
    }
  }

  const summary = summarize(results)
  const report = { startedAt: new Date().toISOString(), suite: args.suite, repeat: args.repeat, base: BASE, results, summary }
  const out = args.out ?? join(HERE, 'reports', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)

  console.log('\n| bài | đỗ | bước TB | giây TB | lỗi công cụ TB |')
  console.log('|---|---|---|---|---|')
  for (const entry of summary) {
    console.log(
      `| ${entry.id} | ${entry.passed}/${entry.runs} | ${mean(entry.steps).toFixed(1)} | ${mean(entry.seconds).toFixed(0)} | ${mean(entry.toolErrors).toFixed(1)} |`,
    )
  }
  const passed = results.filter((result) => result.pass).length
  console.log(`\ntổng: ${passed}/${results.length} lần chạy đỗ — báo cáo: ${out}`)

  if (args.baseline) {
    const old = JSON.parse(await readFile(args.baseline, 'utf-8'))
    const oldByCase = new Map(old.summary.map((entry) => [entry.id, entry]))
    console.log('\nso với lần trước:')
    for (const entry of summary) {
      const before = oldByCase.get(entry.id)
      if (!before) continue
      const rate = (item) => item.passed / item.runs
      const arrow = rate(entry) > rate(before) ? 'tốt lên' : rate(entry) < rate(before) ? 'XẤU ĐI' : '='
      console.log(
        `  ${entry.id}: ${before.passed}/${before.runs} -> ${entry.passed}/${entry.runs} ${arrow}` +
          `  (bước ${mean(before.steps).toFixed(1)} -> ${mean(entry.steps).toFixed(1)}, lỗi ${mean(before.toolErrors).toFixed(1)} -> ${mean(entry.toolErrors).toFixed(1)})`,
      )
    }
  }

  process.exitCode = passed === results.length ? 0 : 1
}

await main()
