import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isAppendSurfaceEvent, type Session } from '@deepseek-ai/dsh-session'

/**
 * Dataset cards (ported from local-fox-harness-core, its docs/data-analyst-agent-review.md I2): what the
 * gateway wrote to `.fox/datasets.json` after the last upload (services/gateway/src/runtime/dataset-cards.ts),
 * turned into a note the model reads before its step. Measured there: a question about a file's shape was
 * answered in 0 steps, and the 1-3 steps every chat spent on list_datasets() + profile_dataset() went away.
 * Reading the card is all this does — the files themselves are profiled by the gateway, never before a step.
 */
export const DATASET_NOTE_PREFIX = 'Datasets in this project'
/** rows × columns is the part the model builds on; the cap keeps a folder of many files from filling the window. */
const MAX_LISTED = 8
const MAX_COLUMNS = 12

interface DatasetCard {
  name: string
  rows?: number
  sampled?: boolean
  columns?: { name: string; dtype: string; nulls: number }[]
  columnCount?: number
  error?: string
}

/** The note for this folder's cards; undefined when it has none. */
export async function datasetCardsNote(cwd: string): Promise<string | undefined> {
  const raw = await readFile(join(cwd, '.fox', 'datasets.json'), 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  let cards: DatasetCard[]
  try {
    cards = (JSON.parse(raw) as { cards: DatasetCard[] }).cards
  } catch {
    return undefined // a card being replaced; the next step reads the new one
  }
  const all = Array.isArray(cards) ? cards : []
  const usable = all.filter((card) => card.error === undefined && Array.isArray(card.columns))
  // Said too: without it the model guessed what an empty or broken upload held (QA 2026-10-15: "rong.csv
  // looks malformed", a corrupt .xlsx summed up as "an Excel file with some data").
  const unreadable = all.filter((card) => card.error !== undefined).slice(0, MAX_LISTED)
    .map((card) => `- ${card.name}: could not be read — ${card.error}`)
  if (usable.length === 0 && unreadable.length === 0) return undefined
  const lines = usable.slice(0, MAX_LISTED).map((card) => {
    const rows = card.rows === undefined ? '?' : `${card.sampled ? '≥' : ''}${card.rows}`
    const total = card.columnCount ?? card.columns!.length
    const columns = card.columns!.slice(0, MAX_COLUMNS)
      .map((column) => `${column.name} ${column.dtype}${column.nulls > 0 ? ` (${column.nulls} null${card.sampled ? ' in the first rows' : ''})` : ''}`)
      .join(', ')
    // Said outright: listing only the columns that have nulls left the model unsure whether the others had none.
    const noNulls = card.columns!.every((column) => column.nulls === 0) ? `; no missing values${card.sampled ? ' in the first rows' : ''}` : ''
    return `- ${card.name}: ${rows} rows × ${total} columns — ${columns}${total > MAX_COLUMNS ? ', …' : ''}${noNulls}`
  })
  const more = usable.length > MAX_LISTED ? `\n(${usable.length - MAX_LISTED} more: list_datasets())` : ''
  return `${DATASET_NOTE_PREFIX} (already profiled: rows, columns, types, missing values — load one with load_dataset("<name>"); call profile_dataset only for what this does not show, such as distributions or value ranges):\n${[...lines, ...unreadable].join('\n')}${more}`
}

/** Latest dataset note still on the model-visible surface, so the same note is not pushed twice. */
export function retainedDatasetNote(session: Session, plugin: string): string | undefined {
  const surface = new Set(session.surface.nodes)
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]!
    if (event.type !== 'user/message' || !isAppendSurfaceEvent(event)) continue
    const { source, content } = event.data
    if (source.kind !== 'plugin' || source.plugin !== plugin) continue
    const text = content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    if (text.startsWith(DATASET_NOTE_PREFIX)) return surface.has(event.seq) ? text : undefined
  }
  return undefined
}
