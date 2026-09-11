# @fox-harness/contracts

Type-only package shared between `services/*` and `apps/web`. No `dsh-` prefix on
purpose — this is not a Cordis plugin and never appears in a `cordis.patch.yml`.

Rule (see `docs/code-rules.md` §1): this is the *only* package `services/*` may
import from. If a service needs something from a bundle package, that's a sign
the logic belongs in `packages/`, not in the service.
