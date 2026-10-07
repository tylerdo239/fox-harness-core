#!/bin/bash
# FOX_SANDBOX_MODE=none — runner for hosts where no sandbox can be built (no namespaces, no capability: e.g. a plain
# Kubernetes pod), for internal test deployments that accept the risk. NOT ISOLATION: the command runs in this
# container with the backend's own user — it can read every user's files and other processes. See
# docs/sandbox-service-plan.md and api/.env.example.
#
# It is called exactly like fox-confine.sh (dsh-sandbox-local's runnerCommand for the bash tool, and the python tool's
# kernel): `<bwrap-style args> -- <command...>`. What it keeps, because none of it needs a privilege:
#   - the command starts in its session's workspace;
#   - only an allow-list of environment variables reaches it (no API key or password sits in its `env`);
#   - resource limits (prlimit): memory, CPU seconds, file size, open files, no core dumps.
set -u

ws=""
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    --bind) ws="$2"; shift 3 ;;
    --ro-bind) shift 3 ;;
    --tmpfs | --dev | --proc) shift 2 ;;
    --unshare-pid | --unshare-net | --die-with-parent) shift ;;
    *) echo "fox-confine: unexpected sandbox argument: $1" >&2; exit 125 ;;
  esac
done
if [ $# -eq 0 ]; then echo "fox-confine: no command" >&2; exit 125; fi
if [ -n "$ws" ]; then
  cd "$ws" || { echo "fox-confine: cannot enter workspace $ws" >&2; exit 125; }
fi

# Same allow-list as fox-confine.sh.
allow='^(PATH|HOME|LANG|LC_[A-Z]+|TERM|TZ|PWD|USER|SHELL|FOX_OUTPUT_DIR|FOX_PYTHON|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|MPLBACKEND|MPLCONFIGDIR)$'
keep=()
# (compgen, not `env -0`: also works with macOS's bash 3.2 and BSD env when developing on a Mac)
for name in $(compgen -e); do
  [[ "$name" =~ $allow ]] && keep+=("$name=${!name}")
done
[ -n "$ws" ] && keep+=("PWD=$ws")

limits=()
if command -v prlimit >/dev/null 2>&1; then
  # RLIMIT_DATA, not RLIMIT_AS: numpy/OpenBLAS reserve far more address space than they use.
  limits=(prlimit
    "--data=$(( ${FOX_NOCONFINE_MEMORY_MB:-4096} * 1024 * 1024 ))"
    "--cpu=${FOX_NOCONFINE_CPU_SECONDS:-3600}"
    "--fsize=$(( ${FOX_NOCONFINE_FILE_MB:-2048} * 1024 * 1024 ))"
    "--nofile=${FOX_NOCONFINE_OPEN_FILES:-4096}"
    --core=0 --)
fi

exec /usr/bin/env -i "${keep[@]}" ${limits[@]+"${limits[@]}"} "$@"
