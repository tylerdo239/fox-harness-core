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
// list directly (same as `@fox-harness/dsh-tool-duckduckgo-web-search`
// always has), materialized as-is for every session.

import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const templateDir = dirname(fileURLToPath(import.meta.resolve('@fox-harness/profile-template/template/profile.package.json')))

// Container-specific override on top of the checked-in (currently empty)
// profile-wide overlay: packages/transport's `host` config defaults to
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
    await writeFile(patchPath, transportRow())
  }
}
