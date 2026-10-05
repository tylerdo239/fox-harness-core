# @fox-harness/dsh-tool-serper-web-search

Google results via [Serper.dev](https://serper.dev) for the model's
`web_search` tool. Needs `SERPER_API_KEY` (in `.env`; orchestrator passes it
into every worker container).

This package registers **no tool of its own**. dsh already ships the pieces:

| Piece | Package | Role |
|---|---|---|
| `web_search` tool | `@deepseek-ai/dsh-tool-web` | what the model sees and calls (1–N queries per call) |
| `ctx.web` | `@deepseek-ai/dsh-web` | routes each search to the selected search source |
| search source `serper` | **this package** | calls Serper, returns `{ sources, truncated }` |

The source is selected in each flow's `packages/profile-template/<flow>/template/cordis.patch.yml`:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: serper
```

Without that row dsh-base selects `deepseek-official`, which fails without
`DEEPSEEK_API_KEY`. dsh-web does not fall back to another source when the
selected one fails: a missing `SERPER_API_KEY` is reported to the model as
`Serper search has no API key`.

Replaced `packages/tool/duckduckgo-web-search` (removed 2026-09-14 — DuckDuckGo
blocked this server's IP with a bot challenge).
