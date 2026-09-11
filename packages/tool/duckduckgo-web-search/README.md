# @fox-harness/dsh-tool-duckduckgo-web-search

Free web search tool, no API key — a pure addition to the plugin tree
(`insert:` only, no existing row touched). Written to close the "tool hoạt
động" (tools work) part of Phase 1's completion test
(docs/agent-core-architecture-roadmap.md — every real chat test before this
one was plain text, no tool calls). Model-facing tool name: `duckduckgo_web_search`.

Lives under `packages/tool/` — grouped by category (`packages/<group>/<pkg>`,
same convention as `packages/llm/`) since this is the first of what may become
several `tool-*` packages, per `docs/code-rules.md` §1's grouping rule
(group once a category has, or is expected to have, more than one package).

**Renamed 2026-09-03** from `dsh-tool-duckduckgo-search` /
`duckduckgo_search` — the shorter name read as ambiguous (search *what*?);
`duckduckgo-web-search` / `duckduckgo_web_search` says explicitly it's web
search, distinct from a future `duckduckgo_news_search` or similar.

## Verified end-to-end (2026-09-03) — including 2 real bugs found and fixed

Registered via the real `defineTool()`/`ctx.tools.register()` API (studied
directly from `@deepseek-ai/dsh-tool-web`'s actual source — same
registration pattern, not guessed). A real chat turn through the real
`agent-driver`, forced to call this tool, returned real DuckDuckGo results —
see the session log excerpt in `docs/code-rules.md` §13.

Getting a real result (not just a clean-looking response) took two more real
bugs, both now fixed in code:

1. **DuckDuckGo has no free general-search API.** Their Instant Answer API
   (`api.duckduckgo.com`) only returns knowledge-graph data (empty for most
   queries) and was ALSO bot-challenged when tried. The real path is what a
   browser does: GET `https://duckduckgo.com/` for a session cookie, then
   POST `https://html.duckduckgo.com/html/` with the cookie — a plain GET
   with no cookie gets an HTTP 202 "anomaly" challenge page instead of results.
2. **Node's built-in `fetch()` gets that same 202 challenge even with a full
   Chrome-shaped header set** (user-agent, accept, sec-ch-ua, sec-fetch-*,
   ...) — confirmed by testing headers alone didn't fix it. Plain `curl` from
   the identical machine/network gets a real 200 with a real cookie on the
   identical request. This almost certainly means DuckDuckGo's bot detection
   fingerprints something below the HTTP header layer (TLS/HTTP2 handshake
   shape) that a JS-level header change cannot spoof. **Fix: `search.ts`
   shells out to `curl`** (`node:child_process.execFile`, arguments passed as
   an array — no shell string, no injection risk) for the two DuckDuckGo
   requests instead of using `fetch()`. Requires `curl` on `PATH` — present
   by default on macOS and virtually every Linux distro, not guaranteed on a
   minimal container image; throws a clear error if missing rather than
   failing silently.

## Also fixed along the way (in `agent-driver`, not this package)

The first real tool-call turn (any tool, not specific to this one) crashed
the driver with `session event "assistant/chunk" carries
non-JSON-serializable data`. Root cause: `translate.ts`'s `tool-call-delta`
chunk set `name: toolCallDelta.function?.name`, which is an EXPLICIT
`{ name: undefined }` on most deltas (a tool call's `name` normally only
appears in the delta that opens the call, not the ones that follow) —
`session.append()` rejects explicit `undefined` as non-serializable, unlike
`JSON.stringify` which silently drops it. Same bug existed at two more spots
in `agent.ts` (`tool/result`'s `error`/`meta`, `assistant/message`'s
`usage`) — all three now build the field conditionally (spread an empty
object instead of setting `undefined`) rather than assigning `undefined`
directly. None of these had ever been exercised before this tool, because no
prior real test triggered a tool call or an unset optional field.

## Limitations

- HTML-scraping-based, not an official API — DuckDuckGo can change their
  markup or protection at any time and silently break this. `search.ts`
  documents exactly which two things (cookie-then-POST, curl-not-fetch) are
  load-bearing, so a future break is easier to diagnose.
- Requires `curl` on `PATH`.
- No image/news/video search, no pagination beyond the first ~10 results.
