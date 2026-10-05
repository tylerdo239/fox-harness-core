# Frontend image: the React SPA (src/) bundled by esbuild and served by nginx, which also forwards the API and the
# chat WebSocket to the backend on the same origin (so the browser needs no CORS and no gateway URL).
#
# Build from THIS folder:
#   docker build -t fox-harness-web:dev ./app
# Run: BACKEND_URL (required, no default — e.g. http://fox-backend:4000) is where /auth, /sessions, ... are
# proxied. Put it in the container's environment (compose: app/.env; Kubernetes: the Deployment's env).

FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app
# Dependencies first, so editing src/ reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM nginx:1.27-alpine
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Runs before nginx's own template step: no BACKEND_URL → refuse to start with a clear message, instead of nginx
# proxying to a guessed host.
COPY docker/require-backend-url.sh /docker-entrypoint.d/05-require-backend-url.sh
COPY --from=build /app/public /usr/share/nginx/html
EXPOSE 80
