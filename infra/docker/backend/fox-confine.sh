#!/bin/bash
# Strict bubblewrap runner for a runtime that hosts MANY users' sessions
# (docs/single-backend-architecture-plan.md §7.2).
#
# @deepseek-ai/dsh-sandbox-local's own bwrap profile starts with `--ro-bind / /`: the
# command can READ the whole filesystem — every other user's workspace included.
# That is fine for dsh's single-user threat model and wrong for ours. dsh-sandbox-local
# lets a deployment replace the runner (`runnerCommand`): it execs
#     <runnerCommand...> <its bwrap args> -- <argv>
# and expects a bwrap-compatible runner. This script reads those args only to learn the
# mode and the session workspace, then runs the command under a profile with an EMPTY
# root: a minimal read-only system, ephemeral /tmp, and the session workspace — nothing else.
# (No --new-session: the python tool interrupts a runaway cell by signalling the process GROUP,
# which a new session would cut off. There is no controlling terminal here to protect.)
set -u

ws=""
write=0
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    --bind) ws="$2"; shift 3 ;;
    --tmpfs) write=1; shift 2 ;;
    --ro-bind) shift 3 ;;
    --dev | --proc) shift 2 ;;
    --unshare-pid | --die-with-parent) shift ;;
    *) echo "fox-confine: unexpected sandbox argument: $1" >&2; exit 125 ;;
  esac
done
if [ $# -eq 0 ]; then echo "fox-confine: no command" >&2; exit 125; fi

args=(--unshare-pid --unshare-ipc --unshare-uts --die-with-parent
  --tmpfs /
  --ro-bind /usr /usr
  --symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64
  --dev /dev --proc /proc)
# Only what a process needs to resolve names, verify TLS and find shared libraries.
for f in /etc/ssl /etc/ca-certificates /etc/resolv.conf /etc/hosts /etc/passwd /etc/group \
         /etc/nsswitch.conf /etc/ld.so.cache /etc/localtime /etc/alternatives /opt/fox-py; do
  [ -e "$f" ] && args+=(--ro-bind "$f" "$f")
done
# Read-only extras the caller asked for (the python tool: its own runner.py/helpers directory).
IFS=: read -r -a extra <<< "${FOX_CONFINE_RO:-}"
for d in "${extra[@]}"; do
  [ -n "$d" ] && [ -e "$d" ] && args+=(--ro-bind "$d" "$d")
done
if [ "$write" = 1 ]; then
  args+=(--tmpfs /tmp)
  [ -n "$ws" ] && args+=(--bind "$ws" "$ws")
elif [ -n "$ws" ]; then
  args+=(--ro-bind "$ws" "$ws")
fi
[ -n "$ws" ] && args+=(--chdir "$ws")

# Environment: ONLY an allow-list reaches the command. The runtime's own environment holds the
# Mongo/Dremio/Meilisearch settings, ... and dsh's scrub only matches KEY|PASSWORD|SECRET|TOKEN.
# `--unsetenv` is not enough: bwrap itself (PID 1 of the new PID namespace) keeps the environment
# it was exec'd with, readable at /proc/1/environ — so the environment is cleared BEFORE bwrap runs.
allow='^(PATH|HOME|LANG|LC_[A-Z]+|TERM|TZ|PWD|USER|SHELL|FOX_OUTPUT_DIR|FOX_PYTHON|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|MPLBACKEND|MPLCONFIGDIR)$'
keep=()
while IFS= read -r -d '' entry; do
  name="${entry%%=*}"
  [[ "$name" =~ $allow ]] && keep+=("$entry")
done < <(env -0)

# bwrap (and its PID-1 init) must survive the interrupt the python tool sends to this process
# group; the interpreter re-enables SIGINT for itself (python-repl/python/runner.py).
trap '' INT

exec /usr/bin/env -i "${keep[@]}" /usr/bin/bwrap "${args[@]}" -- "$@"
