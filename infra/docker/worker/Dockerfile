# Harness worker image (roadmap Phase 3 checklist item 2). One container =
# one session's `dsh` process. Profile config is bind-mounted in at /data by
# services/orchestrator (materialize.ts) before the container ever starts —
# nothing session-specific is baked into this image, so the same image serves
# every session. v1: not size-optimized (whole repo, full reinstall inside
# the image) — see infra/docker/README.md.
#
# Build from the REPO ROOT (needs the whole pnpm workspace):
#   docker build -f infra/docker/worker/Dockerfile -t fox-harness-worker:dev .

# Debian (glibc), not Alpine (musl) — node-pty's prebuilt binaries target
# glibc; confirmed the hard way, allowing its build (pnpm-workspace.yaml)
# alone did not fix Alpine (its own "Checking prebuilds..." step reported
# success without producing a working binary — a musl/glibc mismatch, not a
# missing-toolchain problem, so a C++ toolchain on Alpine wouldn't have
# helped either).
FROM node:22-slim

# `bubblewrap` (2026-09-10, docs/code-rules.md's sandbox entry) — real bug
# fixed: `@deepseek-ai/dsh-base` already mounts `dsh-sandbox-local`/
# `dsh-bash-sandbox`/`dsh-fs-sandbox` (the model-facing bash/fs tools'
# confinement backend) unconditionally, but this image never installed the
# one thing those need on Linux — confirmed the hard way by actually asking
# the model to run a real bash command through a real running session: it
# failed with `SANDBOX_UNAVAILABLE` ("no sandbox backend is usable on this
# host"). Without a working backend, `workspace-write` (the mode sessions
# request) fails CLOSED — no confinement ever silently degrades to
# unconfined execution — so this wasn't a security gap, but it did leave the
# bash tool completely unusable.
# `curl` + `ca-certificates` (2026-09-11, real bug: "websearch tool đang bị
# lỗi" — confirmed the hard way, `docker run --entrypoint sh
# fox-harness-worker:dev -c 'which curl'` → not found) —
# packages/tool/duckduckgo-web-search/src/search.ts shells out to `curl`
# specifically (not Node's built-in `fetch()`, which gets DuckDuckGo's
# bot-challenge even with a full Chrome-shaped header set — see that file's
# own header comment). Every real search tool call from inside a worker
# container has been failing since this image existed; `node:22-slim`
# doesn't ship `curl`, and nothing here ever installed it. Dev testing never
# caught this because the headless host profile (`dsh --profile
# fox-harness-headless`, used to verify this tool back in Phase 1) runs on
# the HOST, where `curl` is already present — the gap only showed up once a
# real per-session Docker container tried the same tool call. Installing
# `curl` alone surfaced a SECOND real bug immediately: every HTTPS request
# failed with `curl: (77) error setting certificate file:
# /etc/ssl/certs/ca-certificates.crt` — `node:22-slim` also doesn't ship a CA
# bundle, so curl had no way to verify any TLS certificate at all. Both
# confirmed fixed together: a real 2-step curl session against the live
# `duckduckgo.com`/`html.duckduckgo.com` from inside a running container
# (not just `which curl`) returns real `HOME status=200`/`SEARCH status=200`
# with real result markup, matching the exact behavior already verified from
# the host.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ bubblewrap curl ca-certificates && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm run build

# services/orchestrator sets this too (belt-and-suspenders default) — real
# value comes from the bind mount, this is just what an image run without
# orchestrator (e.g. manual `docker run` for debugging) falls back to.
ENV DSH_HOME=/data
VOLUME /data

COPY infra/docker/worker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 4001
ENTRYPOINT ["/entrypoint.sh"]
