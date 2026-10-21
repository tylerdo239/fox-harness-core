// Memory limits for the Python sessions (2026-10-20): one budget shared by every session of this runtime,
// and a smaller cap per session so one chat cannot take the whole budget. Both count a session's
// interpreter plus every process it spawned (joblib/loky workers, multiprocessing), read from /proc.
import { readdirSync, readFileSync } from 'node:fs'
import { totalmem } from 'node:os'

const MB = 1024 * 1024
// ponytail: assumes 4 KiB pages (x86-64, most arm64); read `getconf PAGESIZE` if this runs on 64 KiB pages.
const PAGE_BYTES = 4096

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function megabytes(name: string): number | undefined {
  const value = globalThis.process.env[name]
  return value === undefined || value === '' ? undefined : Math.max(0, Number(value) || 0) * MB
}

/** The container's memory limit, or the machine's RAM when it has none. */
function containerBytes(): number {
  let limit = totalmem()
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const value = Number(readOrEmpty(file).trim()) // "max" (no limit) reads as NaN
    if (value > 0 && value < limit) limit = value
  }
  return limit
}

/** Runtimes the gateway runs side by side (FOX_RUNTIME_COUNT): each gets its share of the budget. */
const RUNTIMES = Math.max(1, Number(globalThis.process.env.FOX_RUNTIME_COUNT) || 1)
/**
 * This runtime's share of the memory for all Python sessions of the service: FOX_PY_MEMORY_MB (service-wide),
 * else 70% of the container, divided by the number of runtimes. 0 = no limit.
 */
export const TOTAL_BYTES = Math.floor((megabytes('FOX_PY_MEMORY_MB') ?? containerBytes() * 0.7) / RUNTIMES)
/** One session (interpreter + its workers): FOX_PY_SESSION_MEMORY_MB, else half of this runtime's share. 0 = no limit. */
export const SESSION_BYTES = megabytes('FOX_PY_SESSION_MEMORY_MB') ?? Math.floor(TOTAL_BYTES / 2)

export function mb(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`
}

export interface ProcessTable {
  rss: Map<number, number>
  children: Map<number, number[]>
}

/** Every process's resident memory and children, from /proc/<pid>/stat. */
export function readProcesses(): ProcessTable {
  const rss = new Map<number, number>()
  const children = new Map<number, number[]>()
  let names: string[]
  try {
    names = readdirSync('/proc')
  } catch {
    return { rss, children } // no /proc (macOS): nothing is measured, so no limit is enforced
  }
  for (const name of names) {
    const pid = Number(name)
    if (!Number.isInteger(pid)) continue
    const stat = readOrEmpty(`/proc/${pid}/stat`)
    // "pid (comm) state ppid …": comm may hold spaces and parens, so split after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (fields.length < 22) continue
    const ppid = Number(fields[1])
    rss.set(pid, Number(fields[21]) * PAGE_BYTES)
    const siblings = children.get(ppid)
    if (siblings) siblings.push(pid)
    else children.set(ppid, [pid])
  }
  return { rss, children }
}

export interface SessionUsage {
  bytes: number
  /** The interpreter running runner.py: the session itself, which holds the variables. */
  main: number | undefined
  /** Processes the interpreter spawned: safe to kill, the session survives them. */
  workers: number[]
}

/**
 * A session's processes under `root` (the spawned child: the interpreter itself, or the confinement runner
 * around it). The interpreter is the first python process running runner.py — the bwrap layers above it
 * name runner.py in their own command line too, and a fork()ed worker below it carries the same one, so
 * "first python, top-down" is what tells them apart.
 */
export function sessionUsage(root: number, table: ProcessTable, runner: string): SessionUsage {
  let bytes = 0
  let main: number | undefined
  const workers: number[] = []
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.shift()!
    bytes += table.rss.get(pid) ?? 0
    if (main !== undefined) workers.push(pid)
    else if (isInterpreter(readOrEmpty(`/proc/${pid}/cmdline`).split('\0'), runner)) {
      main = pid
      queue.length = 0 // only the interpreter's own subtree from here on
    }
    queue.push(...(table.children.get(pid) ?? []))
  }
  return { bytes, main, workers }
}

function isInterpreter(argv: string[], runner: string): boolean {
  return /^python/.test(argv[0]?.split('/').pop() ?? '') && argv.includes(runner)
}
