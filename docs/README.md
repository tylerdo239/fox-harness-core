# docs

Current:
- `core-architecture.md` — START HERE: every component of `api/`, how a chat turn runs, and why.
- `deploy.md` — deploying the two images (`app/`, `api/`).
- `admin-guide.md` — admin manual (users, Data Studio sources and who may query them); the user manual is `/docs` (`app/docs-site/`).
- `session-archive-plan.md` — session logs archived to S3 (12 months, restore on reopen, delete on purge), done 2026-10-07.
- `core-readiness-review-2026-10-05.md` — what is ready, what is not, verified results.
- `multi-user-authz.md` — multi-user isolation and role-based access (admin/user), open issues, how to test.
- `deploy-security-checklist.md` — what the deploy's proxy/ingress must do (TLS, headers, X-Forwarded-For, logs).
- `sandbox-service-plan.md` — plan: code-runner service on one unprivileged pod, holds no data (`/sandbox`).
- `data-studio-user-dashboards-plan.md` — per-user Data Studio dashboards and charts (owner_id), done 2026-10-07.
- `single-backend-architecture-plan.md` — why the orchestrator was removed; measured results (§13).
- `schema/` — the MariaDB schema handoff.
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
