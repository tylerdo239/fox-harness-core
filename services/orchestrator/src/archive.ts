// Phase 6 checklist item 4: "nén, archive, xóa theo yêu cầu user." A real
// compress+move, using the real `tar` binary via execFile (args array, no
// shell string) — same "shell out to one real system tool" pattern already
// used for `pnpm` (services/plugin-registry/src/build.ts), not a
// reimplementation.
//
// Deliberately NOT real object storage (S3 etc.) — same "honestly scoped to
// this dev environment" tradeoff services/plugin-registry's artifact store
// already makes (see that service's README): a local directory
// (`config.archiveDir`) stands in for the roadmap's "Log store (object
// storage)" cold tier. A real deployment would point this at an actual
// bucket; the archive/restore CONTRACT here (move dshHomeDir out of the
// live pool, bring it back byte-identical on request) is what matters, not
// the storage backend.

import { execFile } from 'node:child_process'
import { access, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { removeDirContentsAsRoot } from './docker.ts'

const execFileAsync = promisify(execFile)

function archivePathFor(archiveDir: string, sessionId: string): string {
  return join(archiveDir, `${sessionId}.tar.gz`)
}

/** Compress `dshHomeDir` into `archiveDir` and remove the live copy. Idempotent target path (sessionId-keyed), not idempotent on disk state — call only once per hibernated session (sweep.ts's own hibernated-status guard already ensures this). */
export async function archiveSession(dshHomeDir: string, archiveDir: string, sessionId: string): Promise<void> {
  await mkdir(archiveDir, { recursive: true })
  const parent = dirname(dshHomeDir)
  const base = dshHomeDir.slice(parent.length + 1)
  await execFileAsync('tar', ['-czf', archivePathFor(archiveDir, sessionId), '-C', parent, base])
  await rm(dshHomeDir, { recursive: true, force: true })
}

/** Restore a previously-archived session's directory to its original `dshHomeDir` path. Must run before `spawnWorker` can bind-mount it again. */
export async function restoreSession(dshHomeDir: string, archiveDir: string, sessionId: string): Promise<void> {
  const parent = dirname(dshHomeDir)
  await mkdir(parent, { recursive: true })
  await execFileAsync('tar', ['-xzf', archivePathFor(archiveDir, sessionId), '-C', parent])
}

/** `rm -rf dir`, falling back to a root container for files a worker created as root. */
export async function removeTree(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM') throw error
    await removeDirContentsAsRoot(dir)
    await rm(dir, { recursive: true, force: true })
  }
}

/** Real right-to-erasure delete (Phase 6's "xóa theo yêu cầu user") — removes whichever of the live directory / archive tarball actually exists. Does not touch Redis; callers (index.ts) delete the affinity record separately. */
export async function purgeSession(dshHomeDir: string, archiveDir: string, sessionId: string): Promise<void> {
  await removeTree(dshHomeDir)
  await rm(archivePathFor(archiveDir, sessionId), { force: true })
}

export async function isArchived(archiveDir: string, sessionId: string): Promise<boolean> {
  try {
    await access(archivePathFor(archiveDir, sessionId))
    return true
  } catch {
    return false
  }
}
