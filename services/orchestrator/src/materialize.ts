// Roadmap Phase 3 checklist item 5: "Materialize $DSH_HOME/profiles/fox-harness/
// from @fox-harness/profile-template on first boot." Runs on the HOST, before
// a container starts — the result is bind-mounted in as $DSH_HOME, so the
// container itself needs no materialization logic of its own
// (infra/docker/worker just runs `dsh --profile fox-harness`).
//
// profile-template carries no `dsh-` prefix (docs/code-rules.md §1: not a
// Cordis plugin, just template files) — reading its files here is exactly
// the sanctioned use the roadmap names, not the "services/* only imports
// contracts" bundle-internals rule this repo otherwise enforces.
//
// Phase 16 (2026-09-08, docs/agent-core-architecture-roadmap.md): used to
// also query Postgres for the approved plugin catalog and list every one of
// them into `bundles`/`cordis.patch.yml` (disabled, flipped live per-session
// by services/plugin-registry) — removed for real, along with that whole
// service. The real need was "every user gets the same fixed capability
// set", so a new capability now just lives in the template's own `bundles`
// list directly (e.g. `@fox-harness/dsh-tool-serper-web-search`),
// materialized as-is for every session.

import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const templateDir = dirname(fileURLToPath(import.meta.resolve('@fox-harness/profile-template/template/profile.package.json')))

// Real bug found and fixed 2026-09-11: `materializeDshHome()` used to write
// ONLY `transportRow()`'s output to `cordis.patch.yml`, never reading
// `packages/profile-template/template/cordis.patch.yml` at all — despite
// that template file's own header comment calling itself "the profile-wide
// overlay." Any entry checked into that template (the system-prompt
// override added the same day is the first real one) had zero effect on any
// materialized session, silently. Caught while wiring that override in, not
// by a test — a stale-but-plausible comment plus a template file that
// happened to be `[]` this whole time meant nothing ever exercised the gap.
// Fixed by actually reading the template and combining it with the
// container-specific transport row below, instead of discarding it.
// `stripYamlComments`/the `[]`-equality check exist so the combination
// stays a valid single top-level YAML array in both states the template can
// be in (real entries, or the empty `[]` this file used to always ship as) —
// this repo generates cordis.patch.yml by plain string concatenation
// throughout (no YAML library dependency anywhere), so this matches that
// existing convention rather than introducing a new one.
function stripYamlComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .trim()
}

// Container-specific override, combined with the checked-in profile-wide
// overlay by `materializeDshHome` below: packages/transport's `host` config
// defaults to
// 127.0.0.1 (loopback-only), which Docker's published port cannot reach from
// outside the container's network namespace — every containerized worker
// needs this row overridden to bind 0.0.0.0.
//
// Real patch semantics (verified against @deepseek-ai/dsh-app-boot's actual
// `applyEntryPatches`, NOT docs/code-rules.md's §4 prose alone — that prose
// covers this exact form, but it's easy to conflate with the other one):
// there are two distinct patch shapes, not one. `{insert: [...]}` with no
// top-level `id` is a pure, unconditional APPEND (`data.push(...insert)`) —
// this is what packages/transport/cordis.patch.yml uses to ADD the
// `fox-harness-transport` row in the first place, and using it AGAIN here
// for the same id doesn't override anything, it duplicates the row, which
// the loader's `EntryGroup.update` then rejects outright ("duplicate loader
// entry id") — confirmed the hard way, first version of this file used
// `insert:` and every container failed to boot. The override form is
// `{id, ...fields}` with NO `insert` key: it looks the id up in the entry
// map already built from earlier layers and overwrites just those fields on
// the EXISTING row — this is the one actually described by code-rules.md §4.
function transportRow(): string {
  return `- id: fox-harness-transport
  name: '@fox-harness/dsh-transport'
  config:
    host: '0.0.0.0'
    port: 4001
`
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function materializeDshHome(dshHomeDir: string): Promise<void> {
  const profileDir = join(dshHomeDir, 'profiles', 'fox-harness')
  await mkdir(profileDir, { recursive: true })

  const packageJsonPath = join(profileDir, 'package.json')
  if (!(await exists(packageJsonPath))) {
    await copyFile(join(templateDir, 'profile.package.json'), packageJsonPath)
  }

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!(await exists(patchPath))) {
    const templateRaw = await readFile(join(templateDir, 'cordis.patch.yml'), 'utf8')
    const templateHasEntries = stripYamlComments(templateRaw) !== '[]'
    const combined = templateHasEntries ? `${templateRaw.trimEnd()}\n${transportRow()}` : transportRow()
    await writeFile(patchPath, combined)
  }
}
