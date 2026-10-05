#!/usr/bin/env node
// Is @fox-harness/dsh-agent-driver still a faithful replacement for dsh's own agent loop?
//
// Runs the SAME scripted conversations (mock LLM, scripts/mock-llm.mjs) through two headless dsh profiles that
// differ only by the loop — A: dsh-base's @deepseek-ai/dsh-agent-loop, B: + @fox-harness/dsh-agent-core with only
// its loop plugin enabled (policy and transport rows disabled) —
// and compares what each sent to the LLM, request by request: system prompt, tool list, every message. Run it
// before and after bumping any @deepseek-ai/* version (docs/upstream-upgrade-policy.md); a difference means the
// upstream loop changed behaviour the driver does not mirror yet.
//
//   cd api && node scripts/agent-loop-parity.mjs        exit 0 = identical, 1 = a difference (printed)
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = fileURLToPath(new URL('..', import.meta.url))
const MOCK = fileURLToPath(new URL('../../scripts/mock-llm.mjs', import.meta.url))
const DSH = join(API, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const PORT = 4998

const here = mkdtempSync(join(tmpdir(), 'fox-parity-'))
const home = join(here, 'dsh-home')
const ws = join(here, 'ws')
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'note.txt'), 'PARITY-CANARY\n')

const PROFILES = { A: [], B: ['@fox-harness/dsh-agent-core'] }
// B keeps only agent-core's loop: its policy (prompt sections, model routing) and transport (a server) are not the loop
const ONLY_LOOP = '- id: fox-harness-core\n  disabled: true\n- id: fox-harness-transport\n  disabled: true\n'
for (const [name, extra] of Object.entries(PROFILES)) {
  const dir = join(home, 'profiles', `parity-${name}`)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `parity-${name}`,
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@fox-harness/dsh-llm-openai-compat', ...extra] } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: agent-default-model\n  config:\n    provider: openai-compat\n    model: mock\n- id: session-telemetry-otel\n  disabled: true\n' + (name === 'B' ? ONLY_LOOP : ''))
  // what services/gateway/src/runtime/materialize.ts does: our packages importable from the profile
  symlinkSync(join(API, 'node_modules/@fox-harness'), join(dir, 'node_modules/@fox-harness'))
}

const SCENARIOS = {
  plain: 'hello',
  tool: `CALL read {"file_path":"${join(ws, 'note.txt')}"}`,
}

const mock = spawn(process.execPath, [MOCK, String(PORT)], { stdio: 'ignore' })
const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 50; i += 1) {
  if (await fetch(`${base}/_requests`).then(() => true, () => false)) break
  await new Promise((r) => setTimeout(r, 100))
}
const env = { ...process.env, DSH_HOME: home, OPENAI_BASE_URL: base, OPENAI_API_KEY: 'x', OPENAI_MODEL_ID: 'mock', DSH_TELEMETRY_DISABLED: '1' }
const clean = (value) => JSON.stringify(value ?? null).replace(/call_[0-9a-z_]+/g, 'call_X').replaceAll(here, '<tmp>')

let differences = 0
try {
  for (const [scenario, prompt] of Object.entries(SCENARIOS)) {
    const runs = {}
    for (const name of Object.keys(PROFILES)) {
      await fetch(`${base}/_requests`, { method: 'DELETE' })
      let output
      try {
        output = execFileSync(process.execPath, ['--expose-internals', DSH, '--profile', `parity-${name}`, prompt], { cwd: ws, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      } catch (error) {
        output = `FAILED: ${String(error.stderr || error.message).split('\n').find((l) => l.includes('Error')) ?? error.message}`
      }
      runs[name] = { output, requests: await (await fetch(`${base}/_requests`)).json() }
    }
    const { A, B } = runs
    const rows = []
    for (let i = 0; i < Math.max(A.requests.length, B.requests.length); i += 1) {
      for (const field of ['system', 'tools', 'messages']) {
        if (clean(A.requests[i]?.[field]) !== clean(B.requests[i]?.[field])) rows.push(`request ${i + 1} ${field}:\n    A ${clean(A.requests[i]?.[field]).slice(0, 400)}\n    B ${clean(B.requests[i]?.[field]).slice(0, 400)}`)
      }
    }
    if (A.requests.length !== B.requests.length) rows.push(`request count A=${A.requests.length} B=${B.requests.length}`)
    if (clean(A.output) !== clean(B.output)) rows.push(`output:\n    A ${clean(A.output).slice(0, 200)}\n    B ${clean(B.output).slice(0, 200)}`)
    differences += rows.length
    console.log(`${rows.length === 0 ? 'SAME' : 'DIFF'}  ${scenario}: ${A.requests.length} LLM request(s), output ${clean(B.output).slice(0, 60)}`)
    for (const row of rows) console.log(`  ${row}`)
  }
} finally {
  mock.kill()
  rmSync(here, { recursive: true, force: true })
}
console.log(differences === 0 ? '\nagent-core loop matches dsh-agent-loop' : `\n${differences} difference(s)`)
process.exit(differences === 0 ? 0 : 1)
