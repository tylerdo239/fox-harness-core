import { WebError, type WebSearchRequest, type WebSearchResult } from '@deepseek-ai/dsh-web'

const SERPER_URL = 'https://google.serper.dev/search'

interface SerperOrganicResult {
  title?: string
  link?: string
  snippet?: string
  date?: string
}

// Maps only `organic` results; answerBox / peopleAlsoAsk / knowledgeGraph are
// ignored. No field is set to `undefined`: the result lands in the session log,
// which rejects explicit undefined values.
export async function serperSearch(apiKey: string, request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
  const response = await fetch(SERPER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ q: request.query, ...(request.maxResults ? { num: request.maxResults } : {}) }),
    signal,
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200)
    throw new WebError(`Serper search failed: HTTP ${response.status} ${detail}`, 'WEB_PROVIDER_ERROR')
  }

  const data = (await response.json()) as { organic?: SerperOrganicResult[] }
  const sources = (data.organic ?? []).flatMap((item) =>
    item.link
      ? [{ url: item.link, title: item.title ?? '', snippet: item.snippet ?? '', ...(item.date ? { publishedAt: item.date } : {}) }]
      : [],
  )
  return { sources, truncated: false }
}
