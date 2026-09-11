#!/usr/bin/env node
// Phase 6 checklist item 3: "chiến lược nâng cấp upstream ... có smoke test
// cho từng seam bạn phụ thuộc." Run this BEFORE and AFTER bumping any
// @deepseek-ai/* dependency in package.json (docs/upstream-upgrade-policy.md
// has the full procedure) — a failure here means a version bump touched a
// seam this project depends on, before that surfaces as a confusing failure
// somewhere else.
//
// Consolidates the manual verification procedures already used throughout
// Phases 1-5 into one reusable script, run against the real local `dsh` CLI
// (node_modules/.bin/dsh) and a real headless + a real long-running profile
// — no mocks, matching this project's "verify by actually running things"
// discipline everywhere else. Must be run from the repo root (dsh's own
// project-env .env loading depends on invoking-directory cwd, see
// docs/code-rules.md's Phase 2 entry) with real OPENAI_API_KEY/
// OPENAI_BASE_URL/OPENAI_MODEL_ID available (.env or process env).
//
// Coverage (deliberately not exhaustive — the highest-value seams, not
// every corner):
//   1. Headless turn: packages/agent-driver's Agent implementation still
//      produces a real completed turn through a real model call.
//   2. WS replay: packages/transport's snapshot-then-live protocol +
//      session persistence/resume still round-trip a real turn across a
//      disconnect/reconnect — this is the single most load-bearing
//      invariant in the whole project (roadmap: "tiêu chí quan trọng nhất
//      của cả dự án").
//
// Follow-up (2026-09-08): dropped the old "boot manifest lists every
// first-party client-ui-* package" check — that whole mechanism (packages/core's
// ClientManifestRegistry, packages/transport's GET /manifest) was removed
// along with the per-session UI-plugin delivery system (apps/web/README.md).
// `apps/web` is a single, normally-built static bundle now — there is
// nothing left for the WORKER to serve or report about the frontend.
// NOT covered here (documented, not silently skipped): the full Docker
// orchestrator/gateway stack (services/orchestrator/README.md's own kill -9
// test is the authoritative one, but it needs Docker + Redis + MariaDB up
// and is slower than a smoke test should be) and the plugin-registry build
// pipeline (services/plugin-registry/README.md). Run those manually after a
// version bump too if this script passes.

import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname
const DSH_BIN = `${REPO_ROOT}node_modules/.bin/dsh`

// A throwaway $DSH_HOME, regenerated from packages/profile-template on every
// run — deliberately NOT this machine's real `~/.dsh/profiles/fox-harness`
// (a long-lived, hand-set-up local profile from early testing that nothing
// keeps in sync with profile-template as packages get added). Relying on
// that stale profile is exactly the kind of false failure a smoke test must
// not produce: this script found `~/.dsh/profiles/fox-harness` missing 2
// bundle entries the checked-in template already has, the first time this
// script ran for real — a real drift, but not an upstream regression, and
// not something re-running this script should ever be able to trip over
// again. No `node_modules` needed under this throwaway profile dir:
// `resolveBundleDir`'s installation-anchor resolution (walking up from the
// repo's own installed `@deepseek-ai/dsh`) already finds every
// `@fox-harness/*` package via this repo's normal pnpm-hoisted
// node_modules — confirmed in docs/code-rules.md's Phase 3/4 entries.
const SMOKE_DSH_HOME = join(REPO_ROOT, 'data', '_smoke-dsh-home')

async function materializeSmokeProfile() {
  const profileDir = join(SMOKE_DSH_HOME, 'profiles', 'fox-harness')
  await mkdir(profileDir, { recursive: true })
  const templateDir = join(REPO_ROOT, 'packages', 'profile-template', 'template')
  await writeFile(join(profileDir, 'package.json'), await readFile(join(templateDir, 'profile.package.json')))
  await writeFile(join(profileDir, 'cordis.patch.yml'), await readFile(join(templateDir, 'cordis.patch.yml')))
}

const failures = []

function report(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

// --- 1. Headless turn -------------------------------------------------
// Uses this machine's real `~/.dsh/profiles/fox-harness-headless` directly,
// unlike checkManifestAndReplay below — there's no profile-template for a
// headless variant to regenerate from (packages/profile-template only
// templates the transport-based `fox-harness` profile), so this check
// carries the same "could be silently stale" risk that check 2 found and
// worked around. Known gap, not hidden: if this ever produces a false pass
// (or fail) because of local profile drift, that's why.
async function checkHeadlessTurn() {
  const { stdout } = await execFileAsync(
    DSH_BIN,
    ['--profile', 'fox-harness-headless', 'Say the single word PONG and nothing else.'],
    { cwd: REPO_ROOT, timeout: 60000 },
  )
  const text = stdout.trim()
  report('headless turn produces real, non-empty output', text.length > 0, JSON.stringify(text.slice(0, 80)))
}

// --- 2. WS replay --------------------------------------------------------

async function waitForPort(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await sleep(300)
  }
  return false
}

async function withProfileBoot(profileName, fn) {
  await materializeSmokeProfile()
  const child = spawn(DSH_BIN, ['--profile', profileName], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: { ...process.env, DSH_HOME: SMOKE_DSH_HOME },
  })
  try {
    // /plugin-inventory needs no auth at the transport layer (only
    // services/gateway enforces that) and is real, always-present
    // infrastructure (packages/transport/src/server.ts) — a fine readiness
    // probe now that /manifest no longer exists.
    const up = await waitForPort('http://127.0.0.1:4001/plugin-inventory', 30000)
    if (!up) throw new Error(`profile '${profileName}' never became reachable on port 4001`)
    return await fn()
  } finally {
    child.kill('SIGTERM')
    await sleep(500)
  }
}

async function checkReplay() {
  await withProfileBoot('fox-harness', async () => {
    // --- WS replay (snapshot-then-live + resume) ---
    const ws1 = new WebSocket('ws://127.0.0.1:4001/sessions/new')
    await new Promise((resolve, reject) => {
      ws1.once('open', resolve)
      ws1.once('error', reject)
    })
    const frames1 = []
    ws1.on('message', (data) => frames1.push(JSON.parse(data.toString())))
    await sleep(300) // let the 'session' frame land
    const sessionId = frames1.find((f) => f.type === 'session')?.sessionId
    if (!sessionId) throw new Error('never received a session frame')

    ws1.send(JSON.stringify({ type: 'followup', text: 'Say the single word PONG and nothing else.' }))
    const gotMessage = await new Promise((resolve) => {
      const deadline = Date.now() + 30000
      const check = setInterval(() => {
        if (frames1.some((f) => f.type === 'event' && f.event?.type === 'assistant/message')) {
          clearInterval(check)
          resolve(true)
        } else if (Date.now() > deadline) {
          clearInterval(check)
          resolve(false)
        }
      }, 200)
    })
    ws1.close()
    report('WS turn produces a real assistant/message', gotMessage)

    await sleep(300)
    const ws2 = new WebSocket(`ws://127.0.0.1:4001/sessions/${sessionId}`)
    const frames2 = []
    await new Promise((resolve, reject) => {
      ws2.once('open', resolve)
      ws2.once('error', reject)
    })
    ws2.on('message', (data) => frames2.push(JSON.parse(data.toString())))
    await sleep(500)
    const snapshot = frames2.find((f) => f.type === 'snapshot')
    const replayedOk = !!snapshot && snapshot.events.some((e) => e.type === 'assistant/message')
    ws2.close()
    report('reconnect replays the same turn from the durable log (resume seam)', replayedOk)
  })
}

async function main() {
  console.log(`fox-harness-core upstream smoke test — ${new Date().toISOString()}`)
  await checkHeadlessTurn()
  await checkReplay()

  console.log('')
  if (failures.length === 0) {
    console.log('ALL SEAMS OK')
    process.exit(0)
  } else {
    console.log(`FAILED: ${failures.join(', ')}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('smoke test crashed:', error)
  process.exit(1)
})
