#!/bin/sh
# Starts the throwaway stack scripts/e2e-backend.mjs tests: MariaDB + Redis + MinIO + the backend image + the web
# image on a private docker network, and the mock LLM on the host (port 4999). Needs fox-harness-backend:dev and
# fox-harness-web:dev (`docker compose build`, or docker build ./api and ./app). Web is published on :18080.
# Needs scripts/node_modules (`cd scripts && pnpm install`) for e2e-backend.mjs.
set -e
cd "$(dirname "$0")/.."
NET=foxe2e
docker network create $NET >/dev/null 2>&1 || true
docker rm -f foxe2e-mariadb foxe2e-redis foxe2e-minio foxe2e-backend foxe2e-web >/dev/null 2>&1 || true
docker volume rm foxe2e-data >/dev/null 2>&1 || true

pkill -f "scripts/mock-llm.mjs" 2>/dev/null || true
MOCK_BIND=0.0.0.0 nohup node scripts/mock-llm.mjs 4999 >/tmp/foxe2e-mock.log 2>&1 &

docker run -d --name foxe2e-mariadb --network $NET -e MARIADB_ROOT_PASSWORD=x -e MARIADB_DATABASE=discovery-agent \
  -v "$PWD/api/migrations/001_init.sql:/docker-entrypoint-initdb.d/001_init.sql:ro" mariadb:10.11 \
  --character-set-server=latin1 --collation-server=latin1_swedish_ci >/dev/null
# ^ latin1 on purpose: the worst default a provisioned MariaDB can have. 001_init.sql must declare utf8mb4 per table
# (measured: without it a Vietnamese/emoji title fails with ERROR 1366); the unicodeText test proves it does.
docker run -d --name foxe2e-redis --network $NET redis:7-alpine >/dev/null
docker run -d --name foxe2e-minio --network $NET -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin123 minio/minio server /data >/dev/null

# wait for MariaDB to have run the init script (it restarts once after initialising)
i=0
until docker exec foxe2e-mariadb mariadb -uroot -px discovery-agent -e "select 1 from discovery_users limit 1" >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 60 ] && { echo "mariadb not ready"; exit 1; }; sleep 2
done

docker run -d --name foxe2e-backend --network $NET --cap-add SYS_ADMIN --cap-add NET_ADMIN -v foxe2e-data:/data \
  -e GATEWAY_PORT=4000 -e FOX_RUNTIME_COUNT=2 \
  -e DATABASE_URL='mariadb://root:x@foxe2e-mariadb:3306/discovery-agent' -e REDIS_URL=redis://foxe2e-redis:6379 \
  -e S3_ENDPOINT=http://foxe2e-minio:9000 -e S3_BUCKET=fox-harness-skills -e S3_ACCESS_KEY_ID=minioadmin -e S3_SECRET_ACCESS_KEY=minioadmin123 -e S3_FORCE_PATH_STYLE=true \
  -e OPENAI_API_KEY=sk-e2e-not-a-secret -e OPENAI_BASE_URL=http://host.docker.internal:4999 -e OPENAI_MODEL_ID=mock \
  -e MONGODB_URL=mongodb://spike-user:spike-pw@mongo.invalid:27017 \
  -e FOX_IDLE_DISPOSE_MS=8000 -e FOX_IDLE_SWEEP_MS=1000 -e FOX_PY_CELL_TIMEOUT_MS=5000 \
  -e CHAT_RATE_LIMIT_PER_MIN=${E2E_CHAT_LIMIT:-60} \
  fox-harness-backend:dev >/dev/null
# CHAT_RATE_LIMIT_PER_MIN: the suite itself sends one user more than the default 20 messages a minute; gatewayLimits
# reads the same E2E_CHAT_LIMIT to probe the limit.
# There is no self-registration: the e2e test signs up its users through this admin.
docker exec foxe2e-backend node scripts/create-admin.mjs admin@e2e.test admin-e2e-password >/dev/null
docker run -d --name foxe2e-web --network $NET -p 127.0.0.1:18080:80 -e BACKEND_URL=http://foxe2e-backend:4000 fox-harness-web:dev >/dev/null
echo "stack starting; wait for http://127.0.0.1:18080/readyz"
