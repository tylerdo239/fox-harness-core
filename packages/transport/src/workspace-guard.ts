import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolGuard } from '@deepseek-ai/dsh-tools'

// One dsh process serves many users' sessions, so "which files may this agent's
// tools touch" can no longer be answered by "whatever the container sees".
// `dsh-fs-sandbox`'s fence only checks MUTATIONS and always lets reads through,
// and the in-process `read`/`glob`/`grep`/`str_replace_editor` tools run in the
// runtime process itself, outside any bwrap (measured: scripts/spike-single-
// runtime.mjs `crossUserRead`, docs/single-backend-architecture-plan.md).
//
// This guard denies any tool call whose path-like argument resolves — after
// following symlinks — outside the calling session's own cwd. It is a POLICY
// fence in the same sense dsh calls its own one: it has a check-then-use window
// (a symlink flipped between this check and the tool body) and it cannot see
// inside a `bash` command line; kernel-level confinement of bash/python is the
// sandbox's job (bwrap), not this file's.

const PATH_KEYS = new Set(['file_path', 'path', 'paths', 'directory', 'dir', 'cwd', 'notebook_path', 'target', 'source', 'destination', 'old_path', 'new_path'])
// Tools that only read; they may additionally read the shared (read-only) skill/data dirs.
const READ_ONLY_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'skill'])

function realpathOrAncestor(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(current.slice(parent.length + 1))
      current = parent
    }
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function workspaceGuard(sharedReadDirs: readonly string[] = []): ToolGuard {
  const shared = sharedReadDirs.map((dir) => realpathOrAncestor(resolve(dir)))
  return (execution) => {
    const args = execution.arguments
    if (args === null || typeof args !== 'object') return undefined
    const cwd = execution.agent?.session.header.cwd
    if (!cwd) return 'workspace guard: this session has no working directory'
    const root = realpathOrAncestor(resolve(cwd))
    const readOnly = READ_ONLY_TOOLS.has(execution.name)

    const deny = (value: string): string | undefined => {
      const target = realpathOrAncestor(resolve(root, value))
      if (inside(root, target)) return undefined
      if (readOnly && shared.some((dir) => inside(dir, target))) return undefined
      return `workspace guard: "${value}" is outside this session's workspace`
    }

    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      const values = Array.isArray(value) ? value : [value]
      if (PATH_KEYS.has(key)) {
        for (const item of values) {
          if (typeof item !== 'string') continue
          const reason = deny(item)
          if (reason) return reason
        }
      } else if (key === 'pattern' && typeof value === 'string') {
        // A glob pattern can carry its own base ("/other/**", "../x/*").
        if (isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
          const base = value.split(/[\\/]/).filter((part) => !/[*?[\]{}]/.test(part)).join(sep) || sep
          const reason = deny(isAbsolute(value) ? base : value)
          if (reason) return reason
        }
      }
    }
    return undefined
  }
}
