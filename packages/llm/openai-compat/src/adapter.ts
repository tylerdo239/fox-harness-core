import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  assertUsableApiKey,
  attributionHeaders,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

import { parseSse } from './sse.ts'
import { serializeRequest } from './serialize.ts'
import { translate } from './translate.ts'
import type { Config } from './index.ts'

const PACKAGE_NAME = '@fox-harness/dsh-llm-openai-compat'

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
    const body = serializeRequest(options)
    const url = `${this.resolveBaseURL().replace(/\/+$/, '')}/chat/completions`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new LlmError(`request to ${url} failed: ${response.status} ${response.statusText}`, 'REQUEST_FAILED', {
        status: response.status,
        cause: text || undefined,
      })
    }

    yield* translate(parseSse(response.body, this.resolveIdleTimeoutMs()))
  }
}
