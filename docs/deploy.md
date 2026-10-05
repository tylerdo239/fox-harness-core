# Deployment

Two images, built and deployed separately. Each one builds from its own folder:

```bash
docker build -t fox-harness-web:<tag>     ./app     # nginx + the React bundle
docker build -t fox-harness-backend:<tag> ./api     # gateway + the agent runtime(s) it starts
```

The root `docker-compose.yml` is for **local development only** (it also runs MariaDB, Redis, MinIO, MongoDB,
Meilisearch, Dremio and a sample MySQL on one machine). Production runs the two images against real infrastructure.

## What you provide

| Needs | Notes |
|---|---|
| MariaDB 10.11, database `discovery-agent` | Apply `api/migrations/001_init.sql` once (hand `docs/schema/` to whoever provisions it). Every table declares `utf8mb4` itself. |
| Redis | Login tokens (stored as SHA-256) + rate limits only. Not worth backing up. Require a password. |
| S3-compatible bucket | Per-user skill content. Always set `S3_ENDPOINT` unless you really mean AWS S3. |
| The LLM + embeddings | Any OpenAI-compatible `/chat/completions` and `/embeddings` endpoint (`OPENAI_BASE_URL`, `EMBEDDING_BASE_URL`; required — nothing falls back to api.openai.com). |
| MongoDB, Dremio, Meilisearch | Only for the Data Studio flow (`analyze_data`) and its admin UI. Meilisearch: its own container with a volume for `/meili_data`, `MEILI_ENV=production`, `MEILI_MASTER_KEY` (≥16 bytes), `MEILI_NO_ANALYTICS=true`. |
| A persistent volume for `/data` (backend) | **Every conversation, workspace and project.** Back it up. RWO is enough for one replica. |

Outbound internet from the backend: only the LLM/embedding endpoint and `https://google.serper.dev` (web search).
The web container makes no outbound call.

## The web container (`app/`)

- Serves the SPA and forwards `/auth`, `/sessions` (including the chat WebSocket), `/projects`, `/skills`,
  `/custom-skills`, `/models`, `/users`, `/data-studio`, `/healthz`, `/readyz` to `BACKEND_URL`
  (default `http://backend:4000`). Point your load balancer / TLS terminator at this container.
- No secrets, no volume.

## The backend container (`api/`)

- **Environment**: `api/.env.example` lists every variable. Required: `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL_ID`. Data Studio
  adds `MONGODB_URL`, `EMBEDDING_*`, `DREMIO_*`, `MEILISEARCH_*`. Runtime sizing: `FOX_RUNTIME_COUNT`,
  `MAX_CONCURRENT_SESSIONS`, `MAX_SESSIONS_PER_USER`.
- **`cap_add: SYS_ADMIN, NET_ADMIN` are required.** Bubblewrap — the per-session sandbox for model-run
  `bash`/`python` — creates PID, mount and network namespaces (`NET_ADMIN` brings up the loopback of the namespace
  that cuts model-run code off the network). Both are bwrap's own: the command it runs keeps no capability
  (`--cap-drop ALL`). In production (`NODE_ENV=production`, set by the image) the gateway **refuses to start**
  without a working sandbox. If your platform forbids these capabilities, the alternatives are a seccomp/AppArmor
  profile that allows unprivileged user namespaces, or a sandboxed runtime (gVisor/Kata) — then the sandbox runner
  has to be reconsidered; do not turn the requirement off for real users.
- Not published: only the web container talks to it (port 4000).
- **First admin**: `docker exec <backend> node scripts/create-admin.mjs <email> <password>` (never over HTTP).
  Further accounts are created by an admin in Settings → Users.
- **Graceful stop**: on SIGTERM the gateway stops accepting connections and signals each runtime, which
  flushes its session logs; give it 40 s. A runtime killed mid-turn loses only the reply being streamed.
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

Two Deployments (`web` from `app/`, `backend` from `api/` with `replicas: 1`, `strategy: Recreate`), a
Service/Ingress to `web`, a PVC mounted at `/data`, secrets from your secret manager. The backend pod needs the
`SYS_ADMIN` and `NET_ADMIN` capabilities (see above) but **no** Docker socket, no pod-creation RBAC, and no node
access.
