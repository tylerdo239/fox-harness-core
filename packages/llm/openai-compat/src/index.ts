import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-credentials'
import '@deepseek-ai/dsh-launch-environment'

import { OpenAiCompatAdapter } from './adapter.ts'

export const name = 'fox-harness-llm-openai-compat'
export const inject = ['llm']

export interface Config {
  /** Provider route this adapter registers under (`GenerateOptions.provider`). */
  provider: string
  /**
   * Base URL up to but not including `/chat/completions`, e.g.
   * `https://api.openai.com/v1`. Optional — falls back to the `OPENAI_BASE_URL`
   * launch-environment variable (adapter.ts's `resolveBaseURL()`) when unset,
   * so a deploy can be driven by env vars alone with no patch file to edit.
   */
  baseURL?: string
  /** Credential-ref env var name the API key is read from. */
  apiKeyEnv: string
}

export const Config: z<Config> = z.object({
  provider: z.string().default('openai-compat').description('Provider route registered with ctx.llm.'),
  baseURL: z
    .string()
    .description('Base URL, e.g. https://api.openai.com/v1 — optional, falls back to OPENAI_BASE_URL env var.'),
  apiKeyEnv: z
    .string()
    .role('credential-ref')
    .default('OPENAI_API_KEY')
    .description('Env var / credential-ref name the API key resolves from.'),
})

// Generic OpenAI-compatible LLM adapter (roadmap: user asked for their own
// LLM plugin talking to a non-DeepSeek provider). Registered via the same
// `ctx.llm.registerAdapter()` seam `@deepseek-ai/dsh-llm-deepseek` uses —
// this doesn't touch agent-driver or anything else; it's a pure addition,
// following "nấc 2" (only swap what you actually need to swap).
export function apply(ctx: Context, config: Config) {
  const adapter = new OpenAiCompatAdapter(ctx, config)
  ctx.effect(
    () => ctx.llm.registerAdapter([config.provider], adapter),
    'fox-harness-llm-openai-compat.registerAdapter()',
  )
}

export { OpenAiCompatAdapter } from './adapter.ts'
