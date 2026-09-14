import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { WebError } from '@deepseek-ai/dsh-web'

import { serperSearch } from './search.ts'

export const name = 'fox-harness-tool-serper-web-search'
export const inject = ['web']

const API_KEY_ENV = 'SERPER_API_KEY'

// Search source `serper` for dsh's own `web_search` tool (@deepseek-ai/dsh-tool-web).
// This package registers no tool of its own — see README.md.
export function apply(ctx: Context) {
  async function resolveApiKey(): Promise<string> {
    const ref = credentialRef(API_KEY_ENV)
    const key = (await ctx.get('credentials')?.resolve(ref))?.value ?? launchEnvironmentOf(ctx).get(ref)?.value
    if (!key) throw new WebError(`Serper search has no API key: set ${API_KEY_ENV} in .env`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    return key
  }

  ctx.effect(
    () =>
      ctx.web.registerSearchProvider({
        id: 'serper',
        // Always selectable: the key is checked per search, so a missing key
        // surfaces as the clear error above instead of a generic "unavailable".
        available: () => true,
        search: async (request, signal) => serperSearch(await resolveApiKey(), request, signal),
      }),
    'fox-harness-tool-serper-web-search.registerSearchProvider()',
  )
}
