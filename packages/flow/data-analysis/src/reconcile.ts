import { mkdir, readdir, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Every file in a project folder must be exactly one of three things: a file the user uploaded
 * (recorded in `.fox/sources.json`), a file the user explicitly shared into the project
 * (`outputs/`), or one chat's own output (`generated/<session id>/…`). Anything else has no owner,
 * and the UI then shows it in every chat of the project because it cannot tell whose it is
 * (services/orchestrator/src/workspace-files.ts `originOf`, which returns `origin: 'chat'` with no
 * `sessionId`). This walk restores the invariant at the end of every turn by moving anything else
 * into this chat's own folder.
 *
 * Why here and not in the Python tool's own mover (python/runner.py `move_stray_files`): that one
 * runs only after a `python` cell and only over files newer than that cell. Measured over 820
 * stored conversations, the model also writes through `write` (26 calls) and `bash` (42), and a
 * cell killed mid-write leaves files no later cell will look at. One reconciliation per turn
 * covers every writer, including ones added later. The Python mover stays because it reports the
 * new path back inside the same cell, in time for the model to quote it in its answer.
 *
 * Deliberately NOT enforced here: a file the model writes into `outputs/` (it would be shared
 * without anyone approving it). That is a different problem — such a file still has an owner as
 * far as the UI is concerned — and telling a model-written file there from a user-promoted one
 * needs a record of promotions, which does not exist yet.
 */
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function reconcileWorkspace(cwd: string, sessionId: string): Promise<string[]> {
  const sources = await readSources(cwd)
  const own = join('generated', sessionId)
  const moved: string[] = []

  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(cwd, relative), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (relative === '' && entry.name === 'outputs') continue
        // Each chat's own folder, including this chat's, is where files are supposed to be.
        if (relative === 'generated' && SESSION_DIR.test(entry.name)) continue
        await walk(path)
      } else if (entry.isFile() && !sources.has(path)) {
        // A stray file under generated/ keeps its name, not a generated/generated/… path.
        const inside = path.startsWith('generated/') ? path.slice('generated/'.length) : path
        const target = join(cwd, own, inside)
        await mkdir(dirname(target), { recursive: true })
        await rename(join(cwd, path), target).then(
          () => moved.push(`${path} → ${own}/${inside}`),
          () => undefined, // a file that vanished or is being written to is picked up next turn
        )
      }
    }
  }

  await walk('')
  return moved
}

async function readSources(cwd: string): Promise<Set<string>> {
  try {
    return new Set(JSON.parse(await readFile(join(cwd, '.fox', 'sources.json'), 'utf-8')) as string[])
  } catch {
    return new Set() // no manifest: a chat of its own, where every file is that chat's
  }
}
