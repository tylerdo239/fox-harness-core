#!/bin/sh
# $DSH_HOME (/data) is bind-mounted in by services/orchestrator, already
# containing profiles/fox-harness/{package.json,cordis.patch.yml}
# (materialize.ts) before this container ever starts — nothing to set up
# here. WORKDIR stays /repo (set in the Dockerfile) so dsh's bundle packages
# (@fox-harness/dsh-*) resolve through /repo/node_modules; $DSH_HOME only
# governs where profile/session DATA lives, a separate concern.
#
# --expose-internals: our profile sets patchReload:"live" (roadmap §1.3 —
# needed for Phase 4/5's live plugin toggling, not exercised by Phase 3
# itself, but not worth silently regressing here either). Its HMR service
# throws "--expose-internals is required for HMR service" without this flag
# — confirmed the hard way, every container failed to boot without it.
# Invoking bin.js directly (not the node_modules/.bin/dsh shebang) so the
# flag actually reaches the right node process.
set -e

# dsh resolves @deepseek-ai/* bundles (dsh-base, ...) relative to its own
# install location automatically, but a THIRD-PARTY bundle scope (our
# @fox-harness/*) needs to be a real resolvable package from the profile
# directory itself — confirmed the hard way: every worker container failed
# with "Cannot find package '@fox-harness/dsh-...' imported from
# /data/profiles/fox-harness/" without this. The real host testing profiles
# (e.g. ~/.dsh/profiles/fox-harness-transport-test) get there via `pnpm
# install` with `link:` dependencies; doing that at every container boot
# would mean re-resolving a lockfile for no reason, since the target is
# always this same image's own already-hoisted node_modules — a symlink to
# the whole scope is equivalent and instant.
# docs/data-analysis-flow-plan.md: which profile dir this container boots
# with — set by services/orchestrator/src/docker.ts per-flow, defaults to
# the original single-profile name for any image run without it set.
PROFILE_NAME="${DSH_PROFILE_NAME:-fox-harness}"

mkdir -p /data/profiles/$PROFILE_NAME/node_modules
ln -sfn /repo/node_modules/@fox-harness /data/profiles/$PROFILE_NAME/node_modules/@fox-harness

exec node --expose-internals node_modules/@deepseek-ai/dsh/lib/bin.js --profile $PROFILE_NAME
