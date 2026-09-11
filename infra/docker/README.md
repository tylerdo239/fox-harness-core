# infra/docker

Container images: one for the harness worker (profile `fox-harness` +
per-session patch), one per control-plane service (`gateway`, `orchestrator`,
`plugin-registry`).

**`worker/` — real, built, boot-verified (Phase 3, 2026-09-04).** `node:22-slim`
(glibc — `node-pty`, a real `dsh-base` dependency chain, has no working
Alpine/musl prebuild, see docs/code-rules.md §17), whole-repo copy + full
`pnpm install && pnpm run build` inside the image (not size-optimized — v1).
`services/orchestrator/src/docker.ts` spawns it, `$DSH_HOME` bind-mounted at
`/data`, session-specific config materialized by
`services/orchestrator/src/materialize.ts` before the container ever starts.
Build from the repo root:

```
docker build -f infra/docker/worker/Dockerfile -t fox-harness-worker:dev .
```

`docker-compose.dev.yml` at this level runs Redis for local orchestrator
development (no `redis-server`/`redis-cli` installed on the host machine).

Control-plane service images (`gateway`, `orchestrator`, `plugin-registry`)
are not written yet — both currently run as plain host Node processes for
local dev; containerizing them isn't required by any Phase 3 completion
criterion.
