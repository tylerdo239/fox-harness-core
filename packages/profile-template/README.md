# @fox-harness/profile-template

**Not a `dsh` bundle.** Correction from the roadmap (docs/code-rules.md §0.4):
profiles are runtime-materialized directories at `$DSH_HOME/profiles/<name>/`,
not npm packages dsh discovers through `node_modules` resolution the way
bundles are.

This package just holds the template files. Something in `services/orchestrator`
(Phase 3) or a one-off init script (Phase 1) must copy `template/profile.package.json`
to `$DSH_HOME/profiles/fox-harness/package.json` and `template/cordis.patch.yml`
next to it, matching the real shape:

```ts
interface DshProfileManifest { bundles?: string[] }
```

Correction (2026-09-09, re-confirmed against the real installed
`node_modules/@deepseek-ai/dsh-app-boot/lib/types/profile.d.ts`): the real
`DshProfileManifest` type has ONLY `bundles?`. There is no `patchReload`
field at all in the currently-installed dsh version — this doc used to claim
`patchReload: "live"` was required (citing `packages/boot/app-boot/src/profile.ts`
upstream, also still asserted in `docs/code-rules.md` §0.4/§4 as of this
writing — that doc has NOT been re-verified against the current install, this
one now is), and `template/profile.package.json` carried that key
accordingly. Removed here: the field is silently ignored either way (never
enforced), so this was always harmless, just inaccurate to describe as
required. Unclear whether the real upstream type dropped this field in a
later `@deepseek-ai/dsh-app-boot` version, or whether the original research
was wrong from the start — not re-investigated here, flagged for whoever
next touches `docs/code-rules.md`'s §0.4/§4.

## Phase 3 (2026-09-04)

The copy-into-`$DSH_HOME` step is real now: `services/orchestrator/src/materialize.ts`,
per session. Found and fixed one bug in `template/profile.package.json`
getting there: it listed `@deepseek-ai/dsh-web-app` in `bundles`, directly
contradicting roadmap §1.3 ("Không dùng `dsh-web-app`") — a worker must never
serve HTML or run a second-per-user browser app. Removed; the bundle list now
matches what every real working profile (host test profiles, and now every
containerized worker) actually uses.

## TODO

- [x] Once Phase 0 confirms the real component list, update the `bundles` array
      here to match — done; `template/profile.package.json`'s `bundles` is the
      real, current, fixed capability set every worker boots with.
