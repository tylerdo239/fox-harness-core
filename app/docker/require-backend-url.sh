#!/bin/sh
# nginx image entrypoint hook (/docker-entrypoint.d): the web container has nothing to serve the API with until
# it knows where the backend is.
if [ -z "${BACKEND_URL:-}" ]; then
  echo "fox-harness-web: BACKEND_URL is not set (e.g. BACKEND_URL=http://fox-backend:4000) — refusing to start" >&2
  exit 1
fi
case "$BACKEND_URL" in
  http://*|https://*) ;;
  *) echo "fox-harness-web: BACKEND_URL must start with http:// or https:// (got: $BACKEND_URL)" >&2; exit 1 ;;
esac
