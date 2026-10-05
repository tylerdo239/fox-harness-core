# infra/deploy

Deployment of the two services: **`web`** (nginx + the React bundle) and **`backend`** (the gateway and the
agent runtime(s) it starts). `docker-compose.yml` here is the reference.

```bash
docker build -f infra/docker/backend/Dockerfile -t fox-harness-backend:dev .
docker build -f infra/docker/web/Dockerfile     -t fox-harness-web:dev .
cp infra/deploy/.env.example infra/deploy/.env       # fill in
docker compose -f infra/deploy/docker-compose.yml --env-file infra/deploy/.env up -d
```

Open `http://<host>:8080`. Create the first admin with
`docker compose exec backend node scripts/create-admin.mjs <email> <password>`.

## What you provide

| Needs | Notes |
|---|---|
| MariaDB 10.11, database `discovery-agent` | Apply `infra/migrations/001_init.sql` once (hand `docs/schema/` to whoever provisions it). |
| Redis | Login tokens + rate limits only. Not worth backing up. |
| S3-compatible bucket | Per-user skill content. |
| The LLM | Any OpenAI-compatible `/chat/completions` endpoint. |
| MongoDB, Dremio, Meilisearch, embeddings | Only for the Data Studio flow (`analyze_data`) and its admin UI. |
| A persistent volume for `/data` | **Every conversation, workspace and project.** Back it up. RWO is enough for one replica. |

## The backend container

- **`cap_add: SYS_ADMIN, NET_ADMIN` are required.** Bubblewrap — the per-session sandbox for model-run
  `bash`/`python` — creates PID, mount and network namespaces (`NET_ADMIN` brings up the loopback of the namespace
  that cuts model-run code off the network). Both are bwrap's own: the command it runs keeps no capability
  (`--cap-drop ALL`). In production (`NODE_ENV=production`, set by the image) the gateway
  **refuses to start** without a working sandbox, because without it any user's code can read every other
  user's files. If your platform forbids `SYS_ADMIN`, the alternatives are a seccomp/AppArmor profile that
  allows unprivileged user namespaces for this container, or a sandboxed runtime (gVisor/Kata) — then the
  sandbox runner has to be reconsidered; do not turn the requirement off for real users.
- Not published: only the web container talks to it (port 4000). If you terminate TLS elsewhere, point your
  load balancer at the **web** container; it forwards `/auth`, `/sessions` (including the chat WebSocket),
  `/projects`, `/skills`, `/custom-skills`, `/models`, `/users`, `/data-studio` to the backend.
- **Graceful stop**: on SIGTERM the gateway stops accepting connections and signals each runtime, which
  flushes its session logs; `stop_grace_period` (40 s) must cover that. A runtime killed mid-turn loses only
  the reply being streamed (the log closes the turn as `interrupted`); everything before it is kept.
- **Health**: `GET /healthz` (process answers) and `GET /readyz` (the gateway and every runtime can take a
  chat; 503 otherwise). The image's `HEALTHCHECK` uses `/readyz`.
- Runtime output appears in the container log prefixed `[runtime-N]`; gateway lines are JSON with `sessionId`.

## Sizing

- One runtime process serves many sessions. Idle sessions cost ≈0.5 MB (and nothing once dropped from RAM after
  `FOX_IDLE_DISPOSE_MS`). The limit is **sessions streaming at the same time**: roughly 100–150 per runtime
  before latency degrades (measured with a mock LLM; re-measure with yours). Set `FOX_RUNTIME_COUNT` to the
  number of cores you want to use; sessions spread over the runtimes by hash. CPU-heavy tools (`python`,
  `analyze_data`) run in child processes, bounded by `FOX_PY_MAX_KERNELS` and `FOX_DS_WORKERS` per runtime.
- Give the container memory for the runtimes plus Python kernels (a pandas kernel is hundreds of MB).

## More than one backend replica

Not supported out of the box. It needs all of: sticky routing by session id at the load balancer
(consistent hash on `/sessions/<id>`), a shared (RWX) `/data` volume, and a lock so two replicas never open
the same session. Scale **up** first (`FOX_RUNTIME_COUNT`).

## Kubernetes

Two Deployments (`web`, `backend` with `replicas: 1`, `strategy: Recreate`), a Service/Ingress to `web`, a PVC
mounted at `/data`, secrets from your secret manager. The backend pod needs the `SYS_ADMIN` and `NET_ADMIN` capabilities (see
above) but **no** Docker socket, no pod-creation RBAC, and no node access — the reason the previous
orchestrator design could not run there.
