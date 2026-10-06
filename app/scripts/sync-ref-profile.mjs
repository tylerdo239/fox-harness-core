#!/usr/bin/env node
// Copies the reference web's data-profile screens (examples/bot-data-studio-web-main, Next.js + Tailwind +
// shadcn/radix) into app/src/ref/, as-is except for the patches below, so a reference update is a re-run of
// this script (docs/data-studio-update-plan.md, GĐ3). Run by hand: `node scripts/sync-ref-profile.mjs [refRoot]`.
//
// What is ours under src/ref/ (never overwritten): shims/ (fetch to services/gateway, next/link, the radix
// portal container), pages are mounted by components/features/data-studio/DataStudioProfile.tsx.
//
// Patches, each one checked (the script fails when a pattern is not found, i.e. the reference changed):
//   - "use client" dropped (no Next.js here);
//   - pages: React 19's use(params) -> plain props (this app is React 18);
//   - lib/api.ts: fetch(apiUrl(path)) -> refFetch(path) (bearer token, /data-profile -> /data-studio/profile);
//     getEntities/updateEntity -> our gateway's entity routes (shims/fetch.ts);
//   - ui/dialog.tsx, ui/select.tsx: radix portals render inside the `.fh-ref` style scope.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const refRoot = process.argv[2] ?? join(appRoot, '../examples/bot-data-studio-web-main')
const src = join(refRoot, 'src')
const out = join(appRoot, 'src/ref')

const FILES = {
  'components/agent-toggle.tsx': 'components/agent-toggle.tsx',
  'components/edit-entity-dialog.tsx': 'components/edit-entity-dialog.tsx',
  'components/profile-transfer.tsx': 'components/profile-transfer.tsx',
  'components/sql/sql-code.tsx': 'components/sql/sql-code.tsx',
  'lib/api.ts': 'lib/api.ts',
  'lib/json-fields.ts': 'lib/json-fields.ts',
  'lib/profile-help.ts': 'lib/profile-help.ts',
  'lib/types.ts': 'lib/types.ts',
  'lib/use-unsaved-warning.ts': 'lib/use-unsaved-warning.ts',
  'lib/utils.ts': 'lib/utils.ts',
  'app/(app)/data-sources/[id]/page.tsx': 'pages/source-profile.tsx',
  'app/(app)/data-sources/[id]/entities/[entityId]/page.tsx': 'pages/entity-profile.tsx',
  'app/(app)/data-sources/relationships/page.tsx': 'pages/relationships.tsx',
  'app/(app)/metrics/page.tsx': 'pages/metrics.tsx',
  'app/(app)/glossary/page.tsx': 'pages/glossary.tsx',
}
for (const name of ['ai-suggest', 'column-profile-dialog', 'columns-grid', 'field-help', 'filter-editor', 'glossary-editor',
  'json-fields-editor', 'metric-editor', 'profile-checklist', 'relationship-editor', 'relationship-profile-dialog',
  'search-index-status', 'sql-preview', 'table-profile-form', 'value-catalog-editor']) {
  FILES[`components/profile/${name}.tsx`] = `components/profile/${name}.tsx`
}
for (const name of ['badge', 'button', 'card', 'checkbox', 'dialog', 'hover-card', 'input', 'label', 'select', 'switch',
  'table', 'textarea']) {
  FILES[`components/ui/${name}.tsx`] = `components/ui/${name}.tsx`
}

function replace(text, file, from, to, { all = false } = {}) {
  const hits = typeof from === 'string' ? text.split(from).length - 1 : (text.match(from) ?? []).length
  if (hits === 0) throw new Error(`${file}: patch pattern not found: ${from}`)
  if (typeof from === 'string') return all ? text.split(from).join(to) : text.replace(from, to)
  return text.replace(from, to)
}

const PATCHES = {
  'lib/api.ts': (t, f) => {
    t = replace(t, f, 'import { apiUrl } from "@/lib/backend";', 'import { refFetch, oursGetEntities, oursUpdateEntity } from "@/shims/fetch";')
    t = replace(t, f, /fetch\(apiUrl\(([^)]*)\),/g, 'refFetch($1,')
    t = replace(t, f, /export function getEntities\(dataSourceId: string\) \{\n[\s\S]*?\n\}\n/, 'export function getEntities(dataSourceId: string) {\n  return oursGetEntities(dataSourceId);\n}\n')
    t = replace(t, f, /export function updateEntity\(entityId: string, input: EntityUpdateInput\) \{\n[\s\S]*?\n\}\n/, 'export function updateEntity(entityId: string, input: EntityUpdateInput) {\n  return oursUpdateEntity(entityId, input);\n}\n')
    return t
  },
  'pages/source-profile.tsx': (t, f) => {
    t = replace(t, f, 'import { use, useEffect', 'import { useEffect')
    t = replace(t, f, 'params: Promise<{ id: string }>;', 'params: { id: string };')
    return replace(t, f, 'use(params)', 'params')
  },
  'pages/entity-profile.tsx': (t, f) => {
    t = replace(t, f, /import \{ use, /, 'import { ')
    t = replace(t, f, /params: Promise<(\{[^}]*\})>;/, 'params: $1;')
    return replace(t, f, 'use(params)', 'params')
  },
  'components/ui/dialog.tsx': (t, f) => replace(t, f, '<DialogPortal>', '<DialogPortal container={refPortal()}>')
    .replace('import { cn } from "@/lib/utils"', 'import { cn } from "@/lib/utils"\nimport { refPortal } from "@/shims/portal"'),
  'components/ui/select.tsx': (t, f) => replace(t, f, '<SelectPrimitive.Portal>', '<SelectPrimitive.Portal container={refPortal()}>')
    .replace('import { cn } from "@/lib/utils"', 'import { cn } from "@/lib/utils"\nimport { refPortal } from "@/shims/portal"'),
}

for (const [from, to] of Object.entries(FILES)) {
  const source = join(src, from)
  if (!existsSync(source)) throw new Error(`missing in the reference: ${from}`)
  let text = readFileSync(source, 'utf8').replace(/^"use client";?\n+/, '')
  if (PATCHES[to]) text = PATCHES[to](text, to)
  mkdirSync(dirname(join(out, to)), { recursive: true })
  writeFileSync(join(out, to), `// Copied from bot-data-studio-web-main/src/${from} by scripts/sync-ref-profile.mjs — edit there, not here.\n${text}`)
}
console.log(`[sync-ref-profile] ${Object.keys(FILES).length} files -> ${out}`)
// globals.css theme variables are kept by hand in src/ref/ref.css (scoped to .fh-ref)
