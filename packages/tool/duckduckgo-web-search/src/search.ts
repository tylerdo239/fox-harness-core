/**
 * Real, tested (not guessed) DuckDuckGo HTML-results scraper.
 *
 * Two non-obvious things confirmed live before this worked, in order:
 *
 * 1. DuckDuckGo has no free general-search JSON API. Their Instant Answer
 *    API (api.duckduckgo.com) only returns knowledge-graph/infobox data,
 *    empty for most ordinary queries — and was ALSO bot-challenged
 *    (HTTP 202 "anomaly" page) when tried. The real working path is the same
 *    one a browser uses: GET https://duckduckgo.com/ for a session cookie,
 *    then POST (not GET) https://html.duckduckgo.com/html/ with `q` as a
 *    form-urlencoded body, carrying that cookie.
 *
 * 2. Node's built-in `fetch()` (undici) gets the 202 challenge on step 1
 *    EVEN WITH a full Chrome-shaped header set (user-agent, accept,
 *    sec-ch-ua, sec-fetch-*, ...) — DuckDuckGo's bot detection distinguishes
 *    it at a lower level than headers (almost certainly TLS/HTTP2
 *    fingerprinting, which a JS-level header change cannot spoof). Plain
 *    `curl` from the exact same machine/network gets a real 200 with real
 *    cookies on the same request. So this shells out to `curl` (via
 *    `execFile`, args as an array — no shell string, no injection risk) for
 *    the two DuckDuckGo requests instead of using `fetch()`. Confirmed the
 *    hard way: `fetch()`-based first draft ran clean (no throw) but silently
 *    returned zero results on every real query; the `curl`-based rewrite
 *    returns real results for the same query.
 *
 * Requires `curl` on PATH — present by default on macOS and virtually every
 * Linux distro, but not guaranteed on a minimal container image; a clear
 * error is thrown if it's missing rather than failing silently.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DDG_HOME = 'https://duckduckgo.com/'
const DDG_SEARCH = 'https://html.duckduckgo.com/html/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const CURL_TIMEOUT_MS = 15_000

export interface DuckDuckGoResult {
  title: string
  url: string
  snippet: string
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
}

async function curlDuckDuckGoHtml(query: string, signal: AbortSignal | undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fox-harness-ddg-'))
  const cookieJar = join(dir, 'cookies.txt')
  try {
    const baseArgs = ['-sS', '--max-time', String(CURL_TIMEOUT_MS / 1000), '-c', cookieJar, '-b', cookieJar, '-A', USER_AGENT]

    try {
      await execFileAsync('curl', [...baseArgs, '-H', 'Accept-Language: en-US,en;q=0.9', DDG_HOME], { signal })
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        throw new Error('duckduckgo_web_search requires the `curl` command on PATH, which was not found')
      }
      throw error
    }

    const { stdout } = await execFileAsync(
      'curl',
      [
        ...baseArgs,
        '-H',
        'Accept-Language: en-US,en;q=0.9',
        '-H',
        `Referer: ${DDG_HOME}`,
        '--data-urlencode',
        `q=${query}`,
        DDG_SEARCH,
      ],
      { signal, maxBuffer: 10 * 1024 * 1024 },
    )

    return stdout
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const RESULT_LINK_RE = /<a rel="nofollow" class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs
const SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs

export async function duckDuckGoSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<DuckDuckGoResult[]> {
  const html = await curlDuckDuckGoHtml(query, signal)

  const titles: Array<{ url: string; title: string }> = []
  for (const match of html.matchAll(RESULT_LINK_RE)) {
    titles.push({ url: match[1], title: decodeEntities(stripTags(match[2])).trim() })
  }
  const snippets: string[] = []
  for (const match of html.matchAll(SNIPPET_RE)) {
    snippets.push(decodeEntities(stripTags(match[1])).trim())
  }

  // Bug fix 2026-09-09 (docs/security-performance-review-2026-09-09.md's
  // Bug #4): the regex parsing above is inherently fragile (already
  // documented at the top of this file) — if DuckDuckGo changes its markup,
  // or starts serving this server's IP a block/challenge page instead of
  // real results, `titles` silently comes back empty, indistinguishable
  // from a genuine 0-result query. Not attempting to guess at content-based
  // detection of a block page here (no verified real sample of one to
  // match against) — just making the empty case observable at all, with
  // enough to tell the two apart by hand: a genuine 0-result page and a
  // block/challenge page are very different HTML sizes in practice.
  if (titles.length === 0) {
    console.error(`fox-harness-tool-duckduckgo-web-search: 0 results parsed for query "${query}" (html length: ${html.length})`)
  }

  return titles.slice(0, maxResults).map((entry, index) => ({
    title: entry.title,
    url: entry.url,
    snippet: snippets[index] ?? '',
  }))
}
