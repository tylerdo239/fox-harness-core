// Container lifecycle for one harness worker (roadmap Phase 3 checklist item
// 2). `dockerode` — a thin, pure-JS client over the Docker Engine API socket,
// same "one focused library per real external protocol" choice this repo
// already made for `ws` (packages/transport, services/gateway) and `ioredis`
// here — rather than shelling out to the `docker` CLI and parsing its output.

import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

import Docker from 'dockerode'
import { WebSocket } from 'ws'

import { config } from './config.ts'

const docker = new Docker()

export interface SpawnedWorker {
  containerId: string
  host: string
  port: number
}

/**
 * `container.start()` resolves once Docker has launched the process — long
 * before `dsh` finishes booting the profile (full plugin tree activation:
 * node-pty/tool/sandbox rows all have to activate first) and starts actually
 * listening. Confirmed the hard way, twice: without any wait, gateway's
 * proxy got a raw ECONNRESET connecting immediately after `ensureSession()`
 * returned. A plain TCP connect-then-close was NOT enough either — still
 * intermittently reset — almost certainly Docker Desktop's port-forwarding
 * proxy (vpnkit) accepting the TCP handshake before the container's actual
 * listener is ready to take it. A real WebSocket handshake against
 * packages/transport's own protocol is the one check that proves the whole
 * chain (container -> dsh boot -> transport's WS server -> its message
 * handling) is genuinely serving requests, not just that a socket exists.
 * Connecting to a nonsense session id is fine — transport's real, well-
 * defined response to an unrecognized `/sessions/<id>` is a clean
 * `{type:'error'}` frame then close (packages/transport/src/server.ts), not
 * a failure — exactly the definitive response this check needs.
 */
async function waitUntilReachable(host: string, port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const reachable = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://${host}:${port}/sessions/__orchestrator-readiness-probe__`)
      const finish = (ok: boolean) => {
        ws.removeAllListeners()
        ws.terminate()
        resolve(ok)
      }
      ws.once('open', () => finish(true))
      ws.once('message', () => finish(true)) // the expected path: an 'error' frame, still proves the server is live
      ws.once('unexpected-response', () => finish(true)) // a definitive HTTP-level response also proves it
      ws.once('error', () => finish(false))
    })
    if (reachable) return
    if (Date.now() > deadline) {
      throw new Error(`fox-harness-orchestrator: worker at ${host}:${port} never became reachable within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

/**
 * Start one fresh worker container, `dshHomeDir` bind-mounted as its
 * `$DSH_HOME`. Used for BOTH a session's first boot and every rehydrate
 * after hibernate/kill — always a brand-new container, never a restarted
 * one (see services/orchestrator/README.md's hibernate design note): this is
 * what actually exercises the "state comes only from the log" invariant
 * instead of quietly relying on in-container memory surviving.
 */
export async function spawnWorker(dshHomeDir: string, sessionId?: string, modelOverride?: string, profileName: string = 'fox-harness', sessionCwd?: string, projectDir?: string): Promise<SpawnedWorker> {
  const env = config.workerEnvPassthrough
    .filter((name) => name !== 'OPENAI_MODEL_ID' && process.env[name] !== undefined)
    .map((name) => `${name}=${process.env[name]}`)
  // Phase 12 item 4: a per-session model choice (or a rehydrate carrying the
  // one already chosen) always wins over orchestrator's own OPENAI_MODEL_ID
  // env value — filtered out of the passthrough above specifically so it's
  // never set twice with two different values in the same Env array.
  const modelId = modelOverride ?? process.env.OPENAI_MODEL_ID
  if (modelId !== undefined) env.push(`OPENAI_MODEL_ID=${modelId}`)
  env.push(`DSH_HOME=/data`)
  // docs/data-analysis-flow-plan.md: which profile dir/`dsh --profile` name
  // entrypoint.sh should boot with — defaults to the original single-profile
  // name so an image run without this set still behaves exactly as before.
  env.push(`DSH_PROFILE_NAME=${profileName}`)
  // The flow's working directory (config.flows[...].cwd, under /data). Created
  // here on the host so host-side writers (file uploads) own it, not the
  // container's root user.
  const binds = [`${dshHomeDir}:/data`]
  if (sessionCwd !== undefined) {
    await mkdir(join(dshHomeDir, relative('/data', sessionCwd)), { recursive: true })
    env.push(`FOX_SESSION_CWD=${sessionCwd}`)
    // A project chat (docs/rlm-transfer-plan.md 9.1) works in the project's
    // shared folder, mounted over its own; its outputs go to generated/<sessionId>
    // so chats of one project don't overwrite each other.
    if (projectDir !== undefined) {
      await mkdir(projectDir, { recursive: true })
      binds.push(`${projectDir}:${sessionCwd}`)
      if (sessionId) env.push(`FOX_OUTPUT_DIR=generated/${sessionId}`)
    }
  }

  const containerPort = `${config.workerTransportPort}/tcp`
  const container = await docker.createContainer({
    Image: config.workerImage,
    Env: env,
    Labels: {
      'fox-harness.role': 'worker',
      ...(sessionId ? { 'fox-harness.session': sessionId } : {}),
    },
    ExposedPorts: { [containerPort]: {} },
    HostConfig: {
      Binds: binds,
      PortBindings: { [containerPort]: [{ HostPort: '0' }] },
      // Security fix 2026-09-09: real fields confirmed against the
      // installed @types/dockerode (Docker Engine's own HostConfig
      // shape) — Memory in bytes, NanoCpus = cores × 1e9, PidsLimit a
      // plain count. Previously absent entirely: 1 session's container
      // could take all of a shared host's CPU/RAM/PIDs.
      Memory: config.workerMemoryMb * 1024 * 1024,
      NanoCpus: config.workerCpuLimit * 1_000_000_000,
      PidsLimit: config.workerPidsLimit,
      // Sandbox fix 2026-09-11 (docs/code-rules.md) — `dsh-sandbox-local`'s
      // real bwrap probe (`bwrap --unshare-pid --proc /proc ...`, the exact
      // command it runs to confine the bash/fs tools) was confirmed FAILING
      // inside this worker container with "Creating new namespace failed:
      // Operation not permitted", even though bubblewrap was installed and a
      // broader `--unshare-all` smoke test succeeded. Root cause confirmed
      // by direct `docker exec` testing: Docker drops CAP_SYS_ADMIN from
      // containers by default, and creating a PID namespace (needed to
      // remount /proc inside bwrap's sandbox) requires it. Without this, the
      // sandbox backend fails closed (SANDBOX_UNAVAILABLE) rather than
      // silently running unconfined — so this wasn't a security hole, just a
      // missing capability that left the bash tool's confinement unusable.
      //
      // Trade-off, stated plainly: this grants CAP_SYS_ADMIN to the worker
      // container itself (the trusted `dsh` Node process), not to the
      // model's bash commands — bwrap drops privileges for the child it
      // wraps, so a command the model runs is still confined to
      // workspace-write inside its own container. The existing per-session
      // isolation boundary (1 Docker container per session, distinct `/data`
      // bind mount — see Phase 3 below) is unchanged; this only lets the
      // container build a *second*, tighter confinement layer inside itself.
      CapAdd: ['SYS_ADMIN'],
    },
  })
  await container.start()

  const info = await container.inspect()
  const published = info.NetworkSettings.Ports[containerPort]?.[0]
  if (!published) {
    await container.remove({ force: true })
    throw new Error(`fox-harness-orchestrator: container ${container.id} started with no published port`)
  }
  const host = '127.0.0.1'
  const port = Number(published.HostPort)
  await waitUntilReachable(host, port)
  return { containerId: container.id, host, port }
}

/** Hibernate: stop + remove the container, keeping only its bind-mounted directory. */
export async function removeWorker(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId)
  try {
    await container.stop({ t: 5 })
  } catch {
    // already stopped/killed — proceed to remove regardless
  }
  try {
    await container.remove({ force: true })
  } catch {
    // already gone (e.g. removed out-of-band) — nothing left to do
  }
}

/**
 * Empty a host directory from inside a throwaway container. Workers run as
 * root, so files they create (e.g. `sessions/`, mode 700) can't be removed by
 * this process directly.
 */
export async function removeDirContentsAsRoot(hostDir: string): Promise<void> {
  const container = await docker.createContainer({
    Image: config.workerImage,
    Entrypoint: ['find', '/target', '-mindepth', '1', '-delete'],
    HostConfig: { Binds: [`${hostDir}:/target`] },
  })
  try {
    await container.start()
    await container.wait()
  } finally {
    await container.remove({ force: true })
  }
}

/** False for a stopped, killed, or entirely-gone container — the rehydrate trigger. */
export async function isRunning(containerId: string): Promise<boolean> {
  try {
    const info = await docker.getContainer(containerId).inspect()
    return info.State.Running
  } catch {
    return false
  }
}
