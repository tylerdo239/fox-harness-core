// Starts, watches and routes to the agent runtime — the part of services/orchestrator that survives
// (docs/single-backend-architecture-plan.md §2). The orchestrator started one Docker container per
// session; this starts K long-lived `dsh` processes ONCE and keeps them up. A session is served by
// shard `hash(sessionId) % K`. The shards are stateless: every session's state is its log under the
// shared dsh home, so a restarted shard (or a different K after a redeploy) just resumes from disk.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { WebSocket } from 'ws'

import { config } from '../config.ts'
import { materializeProfile, PROFILE_NAME } from './materialize.ts'
import { dshHome } from './paths.ts'

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'gateway', component: 'runtime', event, ...fields }))
}

export interface RuntimeTarget {
  host: string
  port: number
  shard: number
}

interface Shard {
  index: number
  port: number
  child: ChildProcess | undefined
  /** Resolves when the process accepts a real WebSocket handshake; replaced on every restart. */
  ready: Promise<void>
  restarts: number
  stopping: boolean
  failed: boolean
}

const HOST = '127.0.0.1'
const MAX_BACKOFF_MS = 30_000

export class RuntimeSupervisor {
  /**
   * Proves to a runtime that the caller is this gateway. Loopback alone is not a boundary: code the model
   * runs lives on the same machine and could connect to a runtime port. Fresh at every boot, never written
   * to disk, and kept out of anything the sandbox exposes (the runner allow-lists the environment).
   */
  readonly secret = randomBytes(32).toString('hex')
  private readonly shards: Shard[] = []

  /** Header every call to a runtime must carry. */
  get headers(): Record<string, string> {
    return { 'x-fox-harness-internal-secret': this.secret }
  }

  async start(): Promise<void> {
    this.assertDataDirOutsideGit()
    await mkdir(dshHome(), { recursive: true })
    this.assertSandbox()
    await materializeProfile()
    for (let index = 0; index < config.runtimeCount; index += 1) {
      const shard: Shard = {
        index,
        port: config.runtimeBasePort + index,
        child: undefined,
        ready: Promise.resolve(),
        restarts: 0,
        stopping: false,
        failed: false,
      }
      this.shards.push(shard)
      this.launch(shard)
    }
    // Fail loudly at boot instead of at the first user's first message.
    await Promise.all(this.shards.map((shard) => shard.ready))
    log('runtimes_ready', { count: this.shards.length, ports: this.shards.map((shard) => shard.port) })
  }

  /** The runtime process serving `sessionId` (waits while it is (re)starting). */
  async target(sessionId: string): Promise<RuntimeTarget> {
    const shard = this.shardFor(sessionId)
    if (shard.failed) throw new Error(`runtime shard ${shard.index} is down`)
    await shard.ready
    return { host: HOST, port: shard.port, shard: shard.index }
  }

  /** Tell the runtime to forget a session (before its files are deleted). Best effort: a down shard has nothing live. */
  async drop(sessionId: string): Promise<void> {
    const shard = this.shardFor(sessionId)
    try {
      await shard.ready
      const res = await fetch(`http://${HOST}:${shard.port}/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok && res.status !== 404) log('drop_failed', { sessionId, status: res.status })
    } catch (error) {
      log('drop_failed', { sessionId, error: String(error) })
    }
  }

  /** Live, read-only plugin tree of the runtime serving the session (admin diagnostics). */
  async pluginInventory(sessionId: string): Promise<{ status: number; body: string }> {
    const target = await this.target(sessionId)
    const res = await fetch(`http://${target.host}:${target.port}/plugin-inventory`, { headers: this.headers, signal: AbortSignal.timeout(10_000) })
    return { status: res.status, body: await res.text() }
  }

  health(): { ready: boolean; shards: { index: number; port: number; up: boolean; restarts: number }[] } {
    const shards = this.shards.map((shard) => ({ index: shard.index, port: shard.port, up: shard.child?.exitCode === null && !shard.failed, restarts: shard.restarts }))
    return { ready: shards.length > 0 && shards.every((shard) => shard.up), shards }
  }

  /** SIGTERM every runtime and give it a moment to flush logs, then SIGKILL. */
  async stop(graceMs = Number(process.env.FOX_SHUTDOWN_GRACE_MS ?? 20_000)): Promise<void> {
    await Promise.all(
      this.shards.map(async (shard) => {
        shard.stopping = true
        const child = shard.child
        if (!child || child.exitCode !== null) return
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
          child.kill('SIGTERM')
        })
      }),
    )
  }

  private shardFor(sessionId: string): Shard {
    const shard = this.shards[createHash('sha1').update(sessionId).digest().readUInt32BE(0) % this.shards.length]
    if (!shard) throw new Error('no runtime is running')
    return shard
  }

  private assertSandbox(): void {
    const why = this.sandboxProblem()
    if (why === undefined) return
    if (config.requireSandbox) {
      throw new Error(`fox-harness-gateway: FOX_REQUIRE_SANDBOX is on but the strict sandbox is unusable (${why}). Refusing to start: model-run code would see every user's files.`)
    }
    log('sandbox_unavailable', { why, warning: 'bash/python are NOT confined to a session workspace; development only' })
  }

  /** `undefined` when the strict runner demonstrably works on this host; otherwise why not. */
  private sandboxProblem(): string | undefined {
    if (process.platform !== 'linux') return 'not Linux'
    if (config.confineRunner === undefined) return 'infra/docker/backend/fox-confine.sh is missing'
    if (!existsSync('/usr/bin/bwrap')) return '/usr/bin/bwrap is missing'
    // Existence is not enough: creating the namespaces needs CAP_SYS_ADMIN (or user namespaces), which a container
    // does not have by default. Run the real runner once, the way the runtime will, and see it work.
    const probe = spawnSync(config.confineRunner, ['--ro-bind', '/', '/', '--bind', config.dataDir, config.dataDir, '--tmpfs', '/tmp', '--', '/usr/bin/true'], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    if (probe.status === 0) return undefined
    return `the runner failed its self-test (exit ${probe.status}): ${(probe.stderr || probe.error?.message || '').trim().slice(0, 200)} — does the container have CAP_SYS_ADMIN?`
  }

  /** Skill discovery treats the nearest `.git` ancestor as the project root, so a data dir inside a checkout merges every workspace. */
  private assertDataDirOutsideGit(): void {
    for (let dir = config.dataDir; ; dir = join(dir, '..')) {
      if (existsSync(join(dir, '.git'))) {
        throw new Error(`fox-harness-gateway: GATEWAY_DATA_DIR (${config.dataDir}) is inside a git checkout (${dir}); move it outside, or per-user skills would be shared between every workspace.`)
      }
      if (join(dir, '..') === dir) break
    }
  }

  private env(shard: Shard): NodeJS.ProcessEnv {
    const sharedRead = [join(config.repoRoot, 'packages/skills'), join(config.repoRoot, 'packages/flow/data-analysis/skills')].join(delimiter)
    const env: NodeJS.ProcessEnv = {
      // Only what the runtime needs; DATABASE_URL, S3_*, REDIS_URL, ... never reach it.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? 'C.UTF-8',
      DSH_HOME: dshHome(),
      DSH_BUNDLED_SKILL_DIR: join(config.repoRoot, 'packages/skills'),
      FOX_REPO_ROOT: config.repoRoot,
      FOX_DATA_DIR: config.dataDir,
      FOX_INTERNAL_SECRET: this.secret,
      FOX_TRANSPORT_HOST: HOST,
      FOX_TRANSPORT_PORT: String(shard.port),
      FOX_SHARED_READ_DIRS: sharedRead,
    }
    if (config.confineRunner) {
      env.FOX_CONFINE_RUNNER = config.confineRunner
      env.FOX_CONFINE_RO = sharedRead
    }
    for (const name of config.runtimeEnvPassthrough) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    return env
  }

  private launch(shard: Shard): void {
    // cwd is NOT the repo: dsh loads a `.env` from its working directory, and the repo's holds the gateway's secrets.
    const child = spawn(process.execPath, ['--expose-internals', config.dshBin, '--profile', PROFILE_NAME], {
      cwd: dshHome(),
      env: this.env(shard),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    shard.child = child
    const relay = (stream: NodeJS.ReadableStream, name: string) => {
      let pending = ''
      stream.on('data', (chunk: Buffer) => {
        pending += chunk.toString()
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) process.stdout.write(`[runtime-${shard.index}] ${line}\n`)
      })
      stream.on('error', () => undefined)
      void name
    }
    relay(child.stdout!, 'stdout')
    relay(child.stderr!, 'stderr')
    log('runtime_started', { shard: shard.index, pid: child.pid, port: shard.port })

    shard.ready = this.waitUntilReachable(shard)
    // A shard that never becomes reachable must not be an unhandled rejection; callers see it through `ready`.
    shard.ready.catch(() => undefined)

    child.on('exit', (code, signal) => {
      log('runtime_exited', { shard: shard.index, code, signal })
      if (shard.stopping) return
      shard.restarts += 1
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(shard.restarts, 5))
      // Sessions on this shard resume from their logs on the next connect; no state is lost with the process.
      shard.ready = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (shard.stopping) return reject(new Error('stopping'))
          this.launch(shard)
          shard.ready.then(resolve, reject)
        }, delay)
      })
      shard.ready.catch(() => undefined)
    })
  }

  /** A real WebSocket handshake — a bare TCP connect proves nothing: `dsh` accepts the socket long before the profile is booted. */
  private async waitUntilReachable(shard: Shard): Promise<void> {
    const deadline = Date.now() + config.runtimeReadyTimeoutMs
    for (;;) {
      if (shard.child?.exitCode !== null && shard.child?.exitCode !== undefined) throw new Error(`runtime ${shard.index} exited during start-up`)
      const reachable = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://${HOST}:${shard.port}/sessions/__readiness_probe__`, { headers: this.headers })
        const done = (ok: boolean) => {
          ws.removeAllListeners()
          ws.terminate()
          resolve(ok)
        }
        ws.once('open', () => done(true))
        ws.once('message', () => done(true)) // the expected `error` frame for an unknown session
        ws.once('unexpected-response', () => done(true))
        ws.once('error', () => done(false))
      })
      if (reachable) return
      if (Date.now() > deadline) {
        shard.failed = true
        throw new Error(`runtime ${shard.index} (port ${shard.port}) never became reachable within ${config.runtimeReadyTimeoutMs} ms`)
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
}
