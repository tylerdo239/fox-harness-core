# Frontend image: the static React bundle (apps/web) served by nginx, which also forwards the API and the chat
# WebSocket to the backend on the same origin (so the browser needs no CORS and no gateway URL).
#
# Build from the REPO ROOT:
#   docker build -f infra/docker/web/Dockerfile -t fox-harness-web:dev .
# Run: BACKEND_URL (default http://backend:4000) is where /auth, /sessions, ... are proxied.

FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && node scripts/build-web.mjs

FROM nginx:1.27-alpine
COPY infra/docker/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/public /usr/share/nginx/html
ENV BACKEND_URL=http://backend:4000
EXPOSE 80
