// Dataset cards (ported from local-fox-harness-core, its docs/data-analyst-agent-review.md I2): a schema
// summary of each uploaded table — rows, columns, dtypes, nulls — written to `.fox/datasets.json`, which the
// data-analysis flow pushes to the model (packages/flow/data-analysis/src/datasets.ts). The model then knows
// the data before its first step instead of spending 1-3 steps on list_datasets() + profile_dataset().
//
// Built here, after an upload or a delete, and not in the runtime before a step: reading a large workbook takes
// seconds, and a chat must not wait for it. The script reads files a user uploaded, so it runs in the same
// sandbox as the python tool (FOX_CONFINE_RUNNER), with the workspace mounted read-only and nothing else of
// the host — the card is written by this process from the script's stdout.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

import { config } from '../config.ts'
import { errorFields, log } from '../log.ts'
import { readTextInside, writeFileInside } from './safe-fs.ts'

const SCRIPT = join(config.repoRoot, 'packages/flow/data-analysis/python/dataset_cards.py')
const CARD_FILE = '.fox/datasets.json'
const TABULAR = new Set(['.csv', '.tsv', '.xlsx', '.xls', '.parquet'])
const TIMEOUT_MS = 120_000

interface CardFile {
  digest: string
  cards: unknown[]
}

// One refresh of a folder at a time; a refresh that finds the files unchanged since the last card is a no-op.
const running = new Map<string, Promise<void>>()

/** Rebuilds the folder's dataset cards in the background when its uploaded tables changed. Never throws. */
export function refreshDatasetCards(dir: string): void {
  const next = (running.get(dir) ?? Promise.resolve())
    .then(() => refresh(dir))
    .catch((error: unknown) => log('dataset_cards_failed', { dir, ...errorFields(error) }, 'warn'))
  running.set(dir, next)
  void next.finally(() => {
    if (running.get(dir) === next) running.delete(dir)
  })
}

async function refresh(dir: string): Promise<void> {
  const files = await tabularSources(dir)
  const digest = createHash('sha1').update(files.map((file) => `${file.path}:${file.size}:${file.mtime}`).join('\n')).digest('hex')
  // `.fox` read and written through safe-fs: python can replace it with a link to another user's folder
  const current = await readTextInside(dir, CARD_FILE).then((raw) => (raw === undefined ? undefined : (JSON.parse(raw) as CardFile).digest)).catch(() => undefined)
  if (current === digest) return
  const cards = files.length === 0 ? [] : await profile(dir, files.map((file) => file.path))
  await writeFileInside(dir, CARD_FILE, JSON.stringify({ digest, cards } satisfies CardFile))
  log('dataset_cards_written', { dir, files: files.length })
}

/** The folder's uploads (`.fox/sources.json`, runtime/workspace-files.ts) that are tables, newest first. */
async function tabularSources(dir: string): Promise<{ path: string; size: number; mtime: number }[]> {
  const sources = await readTextInside(dir, '.fox/sources.json').then((raw) => JSON.parse(raw ?? '[]') as unknown).catch(() => [])
  const found: { path: string; size: number; mtime: number }[] = []
  for (const path of Array.isArray(sources) ? sources : []) {
    if (typeof path !== 'string' || !TABULAR.has(extname(path).toLowerCase())) continue
    const info = await lstat(join(dir, path)).catch(() => undefined)
    if (info?.isFile()) found.push({ path, size: info.size, mtime: Math.round(info.mtimeMs) })
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

function profile(dir: string, paths: string[]): Promise<unknown[]> {
  const python = process.env.FOX_PYTHON ?? 'python3'
  const runner = config.confineRunner
  // No --tmpfs: the runner then mounts the workspace read-only (docker/fox-confine.sh).
  const [program, ...args] = runner
    ? [runner, '--ro-bind', '/', '/', '--bind', dir, dir, '--', python, '-I', SCRIPT]
    : [python, '-I', SCRIPT]
  return new Promise((resolve, reject) => {
    const child = spawn(program!, args, {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        PYTHONIOENCODING: 'utf-8',
        FOX_PYTHON: python,
        ...(runner ? { FOX_CONFINE_RO: dirname(SCRIPT) } : {}),
      },
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-1000) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`dataset_cards.py exited ${code ?? signal}: ${err.trim()}`))
      try {
        const parsed = JSON.parse(out) as unknown
        if (!Array.isArray(parsed)) throw new Error('not an array')
        resolve(parsed)
      } catch (error) {
        reject(new Error(`dataset_cards.py printed no card list: ${String(error)}`))
      }
    })
    child.stdin.end(JSON.stringify(paths))
  })
}
