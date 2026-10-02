# infra/docker

Container images and local dependencies.

- **`backend/`** — the backend image: services/gateway plus the `dsh` agent runtime it starts. `fox-confine.sh`
  is the strict bubblewrap runner that confines model-run `bash`/`python` to one session's workspace.
  Build from the repo root: `docker build -f infra/docker/backend/Dockerfile -t fox-harness-backend:dev .`
- **`web/`** — nginx + the static React bundle; forwards the API and the chat WebSocket to the backend.
  `docker build -f infra/docker/web/Dockerfile -t fox-harness-web:dev .`
- **`docker-compose.dev.yml`** — local MariaDB, Redis, MinIO, Dremio, Meilisearch and MongoDB for development
  (the gateway and web run as plain host processes in that setup). The deployment itself is `infra/deploy/`.
