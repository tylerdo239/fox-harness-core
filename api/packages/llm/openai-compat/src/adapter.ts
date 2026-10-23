import type { Context } from '@deepseek-ai/cordis'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  assertUsableApiKey,
  attributionHeaders,
  resolveRetryPolicy,
  isContextWindowExceededError,
  isQuotaExceededError,
  type GenerateOptions,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

import { parseSse } from './sse.ts'
import { serializeRequest } from './serialize.ts'
import { translate } from './translate.ts'
import { MALFORMED_TOOL_CALL_CODE } from './tool-call-repair.ts'
import type { Config } from './index.ts'

const PACKAGE_NAME = '@fox-harness/dsh-llm-openai-compat'

// Overflow wordings dsh's own detector misses (ported from examples/pynote-be, measured on vLLM behind LiteLLM): a
// too-long history came back as a plain "400 Bad Request", was coded REQUEST_FAILED, and compaction never ran.
const CONTEXT_OVERFLOW = /ContextWindowExceeded|maximum context length|max_model_len|maximum model length|longer than the maximum|context length|too many tokens|prompt is too long|input is too long|exceeds? the (?:model'?s? )?context/i

// Same status → code mapping as @deepseek-ai/dsh-llm-deepseek's adapter. These
// codes are what dsh-llm-retry (RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT) and
// compaction-basic (CONTEXT_WINDOW_EXCEEDED) act on.
function httpErrorCode(status: number, body: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (isQuotaExceededError(body)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 && (isContextWindowExceededError(body) || CONTEXT_OVERFLOW.test(body))) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (status >= 500) return 'SERVER'
  return 'REQUEST_FAILED'
}

/**
 * Generic OpenAI-compatible chat-completions adapter — works against real
 * OpenAI, Azure OpenAI, and most self-hosted servers (Ollama, vLLM, LM
 * Studio, OpenRouter, ...) that speak the same `/chat/completions` SSE
 * protocol. `stream()` is the only method `LlmAdapter` requires
 * (node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:122-169) — this
 * intentionally does not override `providerInfo`/`listModels`/`resolveModel`,
 * relying on the base class's defaults for v1.
 *
 * Credential resolution and error handling follow the real
 * `dsh-llm-deepseek` adapter's pattern (studied directly from its source,
 * not guessed): `LlmRuntime.stream()` (the `ctx.llm` service wrapping this
 * adapter) normalizes any thrown error into a terminal `error`/`aborted`
 * finish chunk on its own — this method does not need a top-level try/catch.
 */
export class OpenAiCompatAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    super()
  }

  /**
   * dsh-llm-retry's normal policy plus one code: a response whose tool call stays broken after repair (translate.ts,
   * tool-call-repair.ts) is the model misfiring, not the request — the same step run again usually comes back
   * well-formed, and the broken attempt never reaches history.
   */
  private readonly retryPolicy: ResolvedRetryPolicy = resolveRetryPolicy({
    mode: 'normal',
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', MALFORMED_TOOL_CALL_CODE],
  }, 'fox-harness-llm-openai-compat.retryPolicy')

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  private resolveBaseURL(): string {
    if (this.config.baseURL) return this.config.baseURL
    const fromEnv = launchEnvironmentOf(this.ctx).get('OPENAI_BASE_URL')?.value
    if (fromEnv) return fromEnv
    throw new LlmError(
      'no baseURL configured and no OPENAI_BASE_URL launch-environment variable set',
      'MISSING_CONFIG',
    )
  }

  // Performance fix 2026-09-09 (docs/security-performance-review-2026-09-09.md
  // finding #4) — same env-driven fallback pattern as `resolveBaseURL()`
  // above (no new Cordis Config field needed). Default 2 minutes if unset
  // or not a valid positive number.
  private resolveIdleTimeoutMs(): number {
    const raw = launchEnvironmentOf(this.ctx).get('LLM_IDLE_TIMEOUT_MS')?.value
    const parsed = raw ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000
  }

  // Adds the model's context size (OPENAI_CONTEXT_WINDOW) to the base default.
  // compaction-basic needs it to compact before the provider rejects an
  // oversized request; without it only overflow recovery runs, and that fails
  // once the conversation itself no longer fits.
  resolveModel(provider: string, model: string) {
    const contextWindow = Number(launchEnvironmentOf(this.ctx).get('OPENAI_CONTEXT_WINDOW')?.value)
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(Number.isInteger(contextWindow) && contextWindow > 0 ? { context: { contextWindow } } : {}),
    })
  }

  // OPENAI_EXTRA_BODY: a JSON object merged into every request body, for
  // server-specific fields — e.g. vLLM's
  // {"chat_template_kwargs":{"enable_thinking":false}} turns Qwen's thinking off.
  private resolveExtraBody(): Record<string, unknown> {
    const raw = launchEnvironmentOf(this.ctx).get('OPENAI_EXTRA_BODY')?.value
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new LlmError('OPENAI_EXTRA_BODY must be a JSON object', 'MISSING_CONFIG')
    }
    return parsed as Record<string, unknown>
  }

  private async resolveApiKey(): Promise<string> {
    const ref = credentialRef(this.config.apiKeyEnv)

    // ctx.get() looks up an optional service without throwing when it isn't
    // registered — a profile that never installed a credentials provider
    // still resolves the key straight from the launch environment below.
    const credentials = this.ctx.get('credentials')
    if (credentials) {
      const resolved = await credentials.resolve(ref)
      if (resolved) return assertUsableApiKey(resolved.value, PACKAGE_NAME, ref)
    }

    const fallback = launchEnvironmentOf(this.ctx).get(ref)?.value
    if (fallback) return assertUsableApiKey(fallback, PACKAGE_NAME, ref)

    throw new LlmError(
      `no credential found for ${this.config.apiKeyEnv} — set it in the environment or via the credentials seam`,
      'MISSING_CREDENTIAL',
    )
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = await this.resolveApiKey()
    const body = { ...serializeRequest(options), ...this.resolveExtraBody() }
    const url = `${this.resolveBaseURL().replace(/\/+$/, '')}/chat/completions`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...attributionHeaders(),
          // one stable id per conversation: OpenCode Go refuses requests without it; other servers ignore it
          ...(options.sessionId ? { 'x-opencode-session': options.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      // A cancelled turn aborts with dsh's own reason object ({kind:'user'}), and fetch rejects with that exact value
      // — not an Error. Wrapped like dsh-llm-deepseek does, so the turn always closes (pynote-be found a Stop that
      // hung the turn on the bare object).
      if (options.signal?.aborted) throw new LlmError('request aborted by caller', 'ABORTED', { cause: error })
      throw new LlmError(`request to ${url} failed`, 'TRANSPORT', { cause: error })
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      // The body, not just the status: it is the only place a server says WHY, and without it a
      // failed turn records "400 Bad Request" and nothing else — which is exactly how far a real
      // diagnosis got on 2026-09-16 before the body had to be fetched by hand from inside the
      // container. Bounded so a long HTML error page cannot flood the session log.
      throw new LlmError(`request to ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 400)}` : ''}`, httpErrorCode(response.status, text), {
        status: response.status,
        cause: text || undefined,
      })
    }

    try {
      yield* translate(parseSse(response.body, this.resolveIdleTimeoutMs()))
    } catch (error) {
      // the stream reader can reject with the same bare abort reason mid-stream
      if (options.signal?.aborted) throw new LlmError('request aborted by caller', 'ABORTED', { cause: error })
      throw error
    }
  }
}
