#!/bin/sh
docker rm -f foxe2e-mariadb foxe2e-redis foxe2e-minio foxe2e-mongo foxe2e-backend foxe2e-web >/dev/null 2>&1 || true
docker volume rm foxe2e-data >/dev/null 2>&1 || true
docker network rm foxe2e >/dev/null 2>&1 || true
pkill -f "scripts/mock-llm.mjs" 2>/dev/null || true
echo "e2e stack removed"
