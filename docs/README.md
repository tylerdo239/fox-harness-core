# docs

Current:
- `core-architecture.md` — START HERE: every component of `api/`, how a chat turn runs, and why.
- `deploy.md` — deploying the two images (`app/`, `api/`).
- `admin-guide.md` — admin manual (users, Data Studio sources and who may query them); the user manual is `/docs` (`app/docs-site/`).
- `chat-attachments-plan.md` — attaching files in chat (default + data-analysis), done 2026-10-08.
- `file-tools-plan.md` — done 2026-10-22: dedicated file tools (`read`/`edit`/`write`/`glob`/`grep` + new `file_manage`) for file work, `bash` kept for everyone only for programs no tool covers, `python` in the default flow, write gaps of the fs tools closed.
- `admin-usage-dashboard-plan.md` — done 2026-10-22: agent usage recorded per LLM call and per turn into MariaDB (migration 002), `/admin/usage` API and dashboard route; Data Studio pipeline tokens included, no cost.
- `storage-quota-plan.md` — keeping the 12 GB bucket (no lifecycle rule allowed) from filling up: per-user quota, bucket measure and upload block, Settings > Storage, admin/scheduled cleanup of unused files, done 2026-10-15.
- `canvas-storage-plan.md` — done 2026-10-16: canvas history (`.canvas/` snapshots and user edits) deduplicated, indexed, capped, shown and deletable in Settings > Storage; no DB change.
- `workspace-symlink-isolation-plan.md` — done 2026-10-16 (gateway, canvas, runtime reconcile): stop the gateway and the canvas tool from reading/writing outside a workspace through a symlink the model's python made (fd-checked open, canvas read in the sandbox).
- `workspace-archive-plan.md` — uploads and python/agent output (chat and project folders) on S3 as the main copy, restore on reopen, delete on purge, done 2026-10-14.
- `session-archive-plan.md` — session logs archived to S3 (kept until deleted, restore on reopen, delete on purge), done 2026-10-07.
- `core-readiness-review-2026-10-05.md` — what is ready, what is not, verified results.
- `multi-user-authz.md` — multi-user isolation and role-based access (admin/user), open issues, how to test.
- `staging-checklist.md` — step-by-step checklist for putting `api/` and `app/` on staging (infra, env, network, smoke tests, Data Studio).
- `deploy-security-checklist.md` — what the deploy's proxy/ingress must do (TLS, headers, X-Forwarded-For, logs).
- `sandbox-service-plan.md` — plan: code-runner service on one unprivileged pod, holds no data (`/sandbox`).
- `data-studio-user-dashboards-plan.md` — per-user Data Studio dashboards and charts (owner_id), done 2026-10-07.
- `single-backend-architecture-plan.md` — why the orchestrator was removed; measured results (§13).
- `schema/` — the MariaDB schema handoff.
- `meta-ads-mcp-plan.md` — P1–P3 built 2026-10-27 (e2e green against a fake Meta; real Meta app pending): Meta Ads tools to production — per-user OAuth in the gateway, gateway as the MCP client, runtime plugin registering the tool list the gateway fetched from Meta, write tools only after the user confirms.
- `ads-mcp-integration.md` — research + proposal (not started): TikTok Ads and Meta Ads MCP servers (endpoints, OAuth, tools) and how to plug them into the core (shared-token POC, then per-user OAuth through a gateway MCP proxy).
- `data-studio-dremio-staging.md` — what the local stack runs for Data Studio, and connecting to an external (staging) Dremio: requirements and gaps.
- `data-studio-dremio-staging-fix-plan.md` — plan (not started): what to change so Data Studio can use an external Dremio (proxy, CA, re-login, PAT).
- `data-studio-update-plan.md` — adopting the new reference Data Studio (pipeline v4, data profile), incl. the Mongo schema changes.
- `fe-be-split-plan.md` — the app/api split (done 2026-10-05).

**Paths in older documents** (roadmap, code-rules, transfer plans, reviews written before 2026-10-05) use the
layout from before the split:

| Old path | Now |
|---|---|
| `apps/web/` | `app/` |
| `services/gateway/`, `packages/…` | `api/services/gateway/`, `api/packages/…` |
| `packages/agent-driver`, `packages/core`, `packages/transport` | `api/packages/agent-core/src/{loop,policy,transport}` (one package since 2026-10-05) |
| `packages/contracts` | removed; the gateway's own `api/services/gateway/src/api-types.ts` |
| `infra/docker/backend/Dockerfile`, `infra/docker/backend/fox-confine.sh` | `api/Dockerfile`, `api/docker/fox-confine.sh` |
| `infra/docker/web/Dockerfile`, `nginx.conf.template` | `app/Dockerfile`, `app/nginx.conf.template` |
| `infra/migrations/` | `api/migrations/` |
| `infra/deploy/docker-compose.yml`, `infra/docker/docker-compose.dev.yml` | `docker-compose.yml` (local development only) |
| `infra/deploy/README.md` | `docs/deploy.md` |
| root `package.json`, `pnpm-*.yaml`, `tsconfig*.json`, `.env.example` | `api/…` (and `app/` has its own) |
| `scripts/build-web.mjs`, `scripts/serve-web.mjs` | `app/scripts/build.mjs`, `app/scripts/serve.mjs` |
| `scripts/create-admin.mjs`, `spike-*`, `bench/` | `api/scripts/…` |
| `scripts/upstream-smoke-test.mjs` (broken since the single-runtime migration) | replaced by `api/scripts/agent-loop-parity.mjs` |
