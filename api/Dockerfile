# Backend image: services/gateway + the agent runtime(s) it starts. ONE image, ONE container; the gateway
# spawns the `dsh` runtime process(es) itself (services/gateway/src/runtime/supervisor.ts). There is no
# per-session container any more.
#
# Build from THIS folder (api/ is the whole backend pnpm workspace):
#   docker build -t fox-harness-backend:dev ./api
#
# Run it with CAP_SYS_ADMIN and CAP_NET_ADMIN (bubblewrap needs them to create the PID/mount/network namespaces
# that confine each session's bash/python to its own workspace and off the network; the command itself keeps none).
# Mount a persistent volume at /data (everything on disk lives there). See docs/deploy.md.

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

# /repo, as before the app/api split: the profile (FOX_REPO_ROOT) and the e2e tests use these absolute paths.
WORKDIR /repo

# The `analyze_data` tool (packages/tool/data-studio-agent) runs a vendored pipeline as a subprocess in its OWN
# venv (Agno/SQLGlot/chromadb) on Python >= 3.12, which this base image's apt does not ship; `uv` downloads a
# portable CPython instead of relying on apt. Only pyproject.toml + uv.lock decide that venv (the project is not
# itself installed), so they are copied alone first: editing code no longer re-downloads every Python package.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
# The interpreter uv downloads goes under /opt, not /root/.local (mode 700): the backend must also run as a non-root
# user (a Kubernetes pod under Pod Security "restricted"), and then /root is unreadable.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
COPY packages/tool/data-studio-agent/python/pyproject.toml packages/tool/data-studio-agent/python/uv.lock \
  packages/tool/data-studio-agent/python/
RUN cd packages/tool/data-studio-agent/python && uv sync --locked

# Node packages: `pnpm fetch` needs only the lockfile, so the download layer is cached the same way.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm run build

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
