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

// Real bug-class fix (2026-09-11) — Bug #4's original comment (below) said
// "no verified real sample" of a block/challenge page; now there is one,
// captured live from this exact machine after a day of repeated manual curl
// testing triggered it: HTTP 202, a real CAPTCHA page titled "Unfortunately,
// bots use DuckDuckGo too. ... Select all squares containing a duck", with
// `id="challenge-form"` and `class="anomaly-modal__..."` markup — confirmed
// it's an IP-level block, not per-session (a fresh cookie jar still got
// challenged). `anomaly-modal` is specific enough to never false-positive on
// a genuine results/no-results page (grepped a real 0-result page and a real
// results page, both from this same session's testing — neither contains
// it).
const BLOCK_CHALLENGE_MARKER = 'anomaly-modal'

export class DuckDuckGoBlockedError extends Error {
  constructor() {
    super(
      'DuckDuckGo is showing a bot-challenge page instead of search results (likely IP-level rate limiting from this server). This is not a 0-result query — try again later.',
    )
    this.name = 'DuckDuckGoBlockedError'
  }
}

export async function duckDuckGoSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<DuckDuckGoResult[]> {
  const html = await curlDuckDuckGoHtml(query, signal)

  // Checked BEFORE parsing results, not just as a fallback when `titles`
  // comes back empty — a block page could theoretically also happen to
  // contain something `RESULT_LINK_RE` spuriously matches; checking first is
  // unambiguous either way and costs nothing extra.
  if (html.includes(BLOCK_CHALLENGE_MARKER)) {
    console.error(`fox-harness-tool-duckduckgo-web-search: blocked by DuckDuckGo bot-challenge for query "${query}" (html length: ${html.length})`)
    throw new DuckDuckGoBlockedError()
  }

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
  // documented at the top of this file) — if DuckDuckGo changes its markup
  // in some OTHER way than the block page just handled above, `titles` can
  // still silently come back empty, indistinguishable from a genuine
  // 0-result query. Kept as a secondary, lower-confidence signal now that
  // the known real cause has its own explicit check above.
  if (titles.length === 0) {
    console.error(`fox-harness-tool-duckduckgo-web-search: 0 results parsed for query "${query}" (html length: ${html.length})`)
  }

  return titles.slice(0, maxResults).map((entry, index) => ({
    title: entry.title,
    url: entry.url,
    snippet: snippets[index] ?? '',
  }))
}
