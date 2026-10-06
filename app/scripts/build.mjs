#!/usr/bin/env node
// Follow-up (2026-09-08): replaces `scripts/build-client-plugins.mjs`. The
// whole reason that script existed — bundling MULTIPLE independently
// `import()`-ed UI plugin packages, each needing `react`/`react-dom` marked
// `external` and wrapped into a shared module-loader registration so they'd
// all resolve to one React instance — is gone along with the per-session
// dynamically-composed UI plugin mechanism itself (Phase 4-12; see
// app/README.md for why it was removed). There is exactly ONE bundle
// now: `src/main.tsx`, with React embedded normally, like any
// ordinary React app. Runs as the second half of `pnpm run build`
// (app/package.json) — `tsc --noEmit` runs first and owns real type
// checking; this only writes `public/main.js` as a real esbuild bundle (needed for JSX +
// bundling `react`/`react-dom` into one file — plain `tsc` output can't do
// either).

import { build } from 'esbuild'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// app/ — this script lives in app/scripts/.
const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const entry = join(appRoot, 'src/main.tsx')
await build({
  entryPoints: [entry],
  bundle: true,
  outfile: join(appRoot, 'public/main.js'),
  // A plain classic script (index.html has no `type="module"` — nothing in
  // this bundle needs real ESM semantics), one self-contained IIFE.
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  logLevel: 'warning',
})
console.log(`[build] bundled ${entry} -> public/main.js`)

// `sonner` (2026-09-08) ships its own compiled CSS rather than injecting it
// via JS — copy the REAL installed file on every build instead of a
// hand-maintained copy, so it can never silently drift from whatever
// version app/package.json actually pins.
const sonnerCss = join(appRoot, 'node_modules/sonner/dist/styles.css')
const sonnerCssOut = join(appRoot, 'public/sonner.css')
copyFileSync(sonnerCss, sonnerCssOut)
console.log(`[build] copied ${sonnerCss} -> ${sonnerCssOut}`)

// The copied reference data-profile screens (src/ref/) are styled with Tailwind, built here into one stylesheet
// scoped to .fh-ref (tailwind.ref.config.cjs, src/ref/ref.css).
const require = createRequire(import.meta.url)
const postcss = require('postcss')
const tailwind = require('tailwindcss')
const refCssIn = join(appRoot, 'src/ref/ref.css')
const refCssOut = join(appRoot, 'public/ref.css')
const refCss = await postcss([tailwind(join(appRoot, 'tailwind.ref.config.cjs'))]).process(readFileSync(refCssIn, 'utf8'), { from: refCssIn, to: refCssOut })
writeFileSync(refCssOut, refCss.css)
console.log(`[build] tailwind ${refCssIn} -> ${refCssOut}`)
