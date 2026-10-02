# Backend image: services/gateway + the agent runtime(s) it starts. ONE image, ONE container; the gateway
# spawns the `dsh` runtime process(es) itself (services/gateway/src/runtime/supervisor.ts). There is no
# per-session container any more.
#
# Build from the REPO ROOT (needs the whole pnpm workspace):
#   docker build -f infra/docker/backend/Dockerfile -t fox-harness-backend:dev .
#
# Run it with CAP_SYS_ADMIN and CAP_NET_ADMIN (bubblewrap needs them to create the PID/mount/network namespaces
# that confine each session's bash/python to its own workspace and off the network; the command itself keeps none).
# Mount a persistent volume at /data (everything on disk lives there). See infra/deploy/README.md.

# Debian (glibc), not Alpine (musl): node-pty's prebuilt binaries target glibc.
FROM node:22-slim

# bubblewrap: strict per-session sandbox (fox-confine.sh) for model-run bash/python.
# curl + ca-certificates: the model's bash tool, and the HEALTHCHECK.
# python3/make/g++: node-pty (a dsh-base dependency) compiles here.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ bubblewrap curl ca-certificates \
  python3-venv && rm -rf /var/lib/apt/lists/*

# Python for the data-analysis flow's `python` tool (packages/tool/python-repl). A venv because Debian's
# system pip refuses global installs (PEP 668). The list is repeated in packages/flow/data-analysis/src/index.ts's prompt.
RUN python3 -m venv /opt/fox-py \
  && /opt/fox-py/bin/pip install --no-cache-dir ipython pandas numpy matplotlib scipy scikit-learn seaborn openpyxl pyarrow \
    statsmodels duckdb pillow lightgbm xgboost-cpu
ENV FOX_PYTHON=/opt/fox-py/bin/python
# `python`/`python3` inside a cell's subprocess (a skill's scripts/*.py) must be this venv too.
ENV PATH=/opt/fox-py/bin:$PATH

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm run build

# The `analyze_data` tool (packages/tool/data-studio-agent) runs a vendored pipeline as a subprocess in its OWN
# venv (Agno/SQLGlot/chromadb) on Python >= 3.12, which this base image's apt does not ship; `uv` downloads a
# portable CPython instead of relying on apt.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN cd packages/tool/data-studio-agent/python && uv sync --locked
ENV FOX_PYTHON_DATA_STUDIO=/repo/packages/tool/data-studio-agent/python/.venv/bin/python
ENV DATA_STUDIO_AGENT_DIR=/repo/packages/tool/data-studio-agent/python

# Production mode makes the gateway refuse to start without the strict sandbox (FOX_REQUIRE_SANDBOX defaults on):
# running model code with no per-user confinement would expose every user's files to every other.
ENV NODE_ENV=production
# Sessions, workspaces, projects and the dsh logs. Mount a volume here: losing it loses every conversation.
ENV GATEWAY_DATA_DIR=/data
VOLUME /data

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD curl -fsS http://127.0.0.1:4000/readyz || exit 1
CMD ["node", "services/gateway/lib/index.js"]
