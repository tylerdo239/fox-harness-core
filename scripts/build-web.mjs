#!/usr/bin/env node
// Follow-up (2026-09-08): replaces `scripts/build-client-plugins.mjs`. The
// whole reason that script existed — bundling MULTIPLE independently
// `import()`-ed UI plugin packages, each needing `react`/`react-dom` marked
// `external` and wrapped into a shared module-loader registration so they'd
// all resolve to one React instance — is gone along with the per-session
// dynamically-composed UI plugin mechanism itself (Phase 4-12; see
// apps/web/README.md for why it was removed). There is exactly ONE bundle
// now: `apps/web/src/main.tsx`, with React embedded normally, like any
// ordinary React app. Runs as the second half of `pnpm run
// build`/`typecheck` (root package.json) — `tsc -b` runs first and owns
// real type checking for every package; this only replaces
// `apps/web/public/main.js` with a real esbuild bundle (needed for JSX +
// bundling `react`/`react-dom` into one file — plain `tsc` output can't do
// either).

import { build } from 'esbuild'
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const entry = join(repoRoot, 'apps/web/src/main.tsx')
await build({
  entryPoints: [entry],
  bundle: true,
  outfile: join(repoRoot, 'apps/web/public/main.js'),
  // A plain classic script (index.html has no `type="module"` — nothing in
  // this bundle needs real ESM semantics), one self-contained IIFE.
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  logLevel: 'warning',
})
console.log(`[build-web] bundled ${entry} -> apps/web/public/main.js`)

// `sonner` (2026-09-08) ships its own compiled CSS rather than injecting it
// via JS — copy the REAL installed file on every build instead of a
// hand-maintained copy, so it can never silently drift from whatever
// version apps/web/package.json actually pins.
const sonnerCss = join(repoRoot, 'node_modules/sonner/dist/styles.css')
const sonnerCssOut = join(repoRoot, 'apps/web/public/sonner.css')
copyFileSync(sonnerCss, sonnerCssOut)
console.log(`[build-web] copied ${sonnerCss} -> ${sonnerCssOut}`)
