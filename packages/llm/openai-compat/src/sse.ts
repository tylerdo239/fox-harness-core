import { EventSourceParserStream } from 'eventsource-parser/stream'

// Performance fix 2026-09-09 (docs/security-performance-review-2026-09-09.md
// finding #4): `reader.read()` had no timeout at all — a server that
// accepts the request, sends SSE headers, then never writes another byte
// (or never sends `[DONE]`) hung this forever, pinning 1 whole worker
// container on a turn that will never complete (idle-TTL doesn't catch
// this: it only tracks WS connection activity, not turn state). This is an
// IDLE timeout, reset on every real chunk — not a total-request timeout, a
// genuinely long real response must still be allowed to keep streaming.
class SseIdleTimeoutError extends Error {}

async function readWithIdleTimeout<T>(reader: ReadableStreamDefaultReader<T>, idleTimeoutMs: number): ReturnType<typeof reader.read> {
  let timeoutHandle: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new SseIdleTimeoutError(`no data received for ${idleTimeoutMs}ms`)), idleTimeoutMs)
  })
  try {
    return await Promise.race([reader.read(), timeout])
  } finally {
    clearTimeout(timeoutHandle!)
  }
}

/**
 * Turn a fetch response body into individual SSE `data:` payload strings,
 * yielding the literal `[DONE]` sentinel last (the OpenAI chat-completions
 * streaming convention). Adapted from the real `dsh-llm-deepseek` adapter's
 * `sse.ts` (near-verbatim — this part isn't provider-specific).
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>, idleTimeoutMs: number): AsyncGenerator<string> {
  // TS's DOM lib types TextDecoderStream.writable as WritableStream<BufferSource>
  // while `fetch()`'s body is ReadableStream<Uint8Array> — a real generic
  // mismatch between lib.dom.d.ts's BufferSource and Uint8Array<ArrayBufferLike>
  // typings, not an actual runtime incompatibility (Uint8Array IS a BufferSource).
  const events = (stream as ReadableStream<BufferSource>)
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())

  const reader = events.getReader()
  let sawDone = false
  try {
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>
      try {
        read = await readWithIdleTimeout(reader, idleTimeoutMs)
      } catch (error) {
        if (error instanceof SseIdleTimeoutError) {
          // Genuinely aborts the underlying fetch/stream, not just releases
          // the lock — the `finally` below still runs after this.
          await reader.cancel(error).catch(() => {})
        }
        throw error
      }
      const { done, value } = read
      if (done) break
      if (value.data === '[DONE]') {
        sawDone = true
        yield '[DONE]'
        break
      }
      yield value.data
    }
  } finally {
    reader.releaseLock()
  }
  if (!sawDone) {
    throw new Error('fox-harness-llm-openai-compat: stream closed before [DONE]')
  }
}
