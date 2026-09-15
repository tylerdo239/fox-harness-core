/**
 * Transparent WS↔WS relay to the one fixed worker's `packages/transport`
 * endpoint (roadmap Phase 2: "một worker cố định. Chưa multi-user" — no
 * per-user routing/affinity yet, that's Phase 3's orchestrator). Frames are
 * relayed verbatim (opaque strings) — the gateway does not parse or
 * understand `packages/transport`'s wire protocol, keeping the two
 * decoupled. This also means log-before-fanout needs no new work here: it's
 * already guaranteed on the worker side (docs/code-rules.md §15), and a
 * transparent relay can't reorder or race that.
 */

import WebSocket from 'ws'

export function proxyToWorker(
  browserWs: WebSocket,
  workerUrl: string,
  onClientMessage?: () => void,
  onEveryClientMessage?: () => void,
): void {
  const workerWs = new WebSocket(workerUrl)

  // Buffer browser->worker frames that arrive before the upstream socket is
  // open — a real race otherwise: the browser can send its first followup
  // the instant its own socket opens, faster than our outbound connection
  // to the worker finishes connecting.
  const pending: string[] = []
  // Performance fix 2026-09-09 (docs/security-performance-review-2026-09-09.md
  // finding #8): `pending` had no cap at all — normally this window is only
  // the few ms our own outbound WS handshake to the worker takes
  // (orchestrator's `waitUntilReachable` already proved the worker
  // reachable before gateway ever got here), so this basically never trips
  // in real use — cheap insurance against a pathological/malicious client,
  // not a fix for a common case. Real user messages, never silently
  // dropped: close code 1013 ("Try again later") instead.
  const MAX_PENDING_BYTES = 2 * 1024 * 1024
  let pendingBytes = 0
  let workerOpen = false
  // 2026-09-09: `onClientMessage` fires on the FIRST browser->worker frame,
  // still without parsing it — `apps/web/src/wire.ts`'s real
  // `ClientToServer` type only ever carries `{type:'followup'|'steer'|'cancel'}`, so
  // any frame arriving here at all already IS a real message by the wire
  // protocol's own contract, no JSON decoding needed to know that (staying
  // byte-blind, same as every other frame this function relays).
  let notifiedClientMessage = false

  workerWs.on('open', () => {
    workerOpen = true
    for (const frame of pending.splice(0)) workerWs.send(frame)
  })

  browserWs.on('message', (data) => {
    if (!notifiedClientMessage) {
      notifiedClientMessage = true
      onClientMessage?.()
    }
    // 2026-09-09: fires on EVERY client->worker frame, unlike the one-shot
    // callback above — index.ts uses this to renew the login token's TTL on
    // real WS activity (sliding expiration), which needs to keep happening
    // for as long as the user keeps sending messages, not just the first
    // one. No throttling needed: client->worker frames only ever happen on
    // a human send/steer (bounded by typing speed) — streaming chunks flow
    // worker->browser, the opposite direction, never through this path.
    onEveryClientMessage?.()
    const frame = data.toString()
    if (workerOpen) {
      workerWs.send(frame)
      return
    }
    pendingBytes += Buffer.byteLength(frame)
    if (pendingBytes > MAX_PENDING_BYTES) {
      browserWs.close(1013, 'worker connection did not open in time')
      return
    }
    pending.push(frame)
  })

  workerWs.on('message', (data) => {
    if (browserWs.readyState === browserWs.OPEN) browserWs.send(data.toString())
  })

  const closeBoth = () => {
    if (browserWs.readyState === browserWs.OPEN || browserWs.readyState === browserWs.CONNECTING) browserWs.close()
    if (workerWs.readyState === workerWs.OPEN || workerWs.readyState === workerWs.CONNECTING) workerWs.close()
  }

  browserWs.on('close', closeBoth)
  workerWs.on('close', closeBoth)
  browserWs.on('error', closeBoth)
  workerWs.on('error', (error) => {
    console.error('fox-harness-gateway: worker connection error:', error)
    closeBoth()
  })
}
