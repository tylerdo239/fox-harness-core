#!/usr/bin/env node
// Bundle budget (docs/ui-performance-plan.md §7), run at the end of `pnpm run build`: the JavaScript the first page
// loads (dist/index.html's entry script and its modulepreloads) must stay under ENTRY_BUDGET gzipped, so a new
// import can't quietly pull a heavy library back into the first load. Lists every chunk with its gzip size.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

// 2026-10-30: 233 KB after phase 1, 256 KB with React 19 (+~11 KB) and TanStack Query (+~12 KB, 7 -> 2 requests
// when the app opens). Raise only on purpose, with the reason here.
const ENTRY_BUDGET = 260 * 1024
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const initial = new Set([...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]))
const gz = (file) => gzipSync(readFileSync(join(dist, file))).length
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`

let entryTotal = 0
const rows = readdirSync(join(dist, 'assets'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ file: `assets/${name}`, size: gz(`assets/${name}`) }))
  .sort((a, b) => b.size - a.size)
for (const row of rows) {
  const first = initial.has(row.file)
  if (first) entryTotal += row.size
  console.log(`${first ? '*' : ' '} ${kb(row.size).padStart(10)}  ${row.file}`)
}
console.log(`\nfirst load (*): ${kb(entryTotal)} gzip, budget ${kb(ENTRY_BUDGET)}`)
if (entryTotal > ENTRY_BUDGET) {
  console.error('over budget: load the new code lazily (src/lazyLoad.ts) or raise ENTRY_BUDGET on purpose')
  process.exit(1)
}
