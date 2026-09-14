# @fox-harness/skills

**Not a `dsh` bundle** — no code, nothing to build. Each directory is one
built-in skill (`<name>/SKILL.md`, optional `references/`, `scripts/`,
`templates/`, `checklists/`) available to every user.

## How it is loaded

- `infra/docker/worker/Dockerfile` sets
  `DSH_BUNDLED_SKILL_DIR=/repo/packages/skills`. The already-mounted
  `@deepseek-ai/dsh-skill-filesystem` scans it as its `bundled` root.
- `bundled` has the lowest precedence (rank 600). A per-user skill in
  `$DSH_HOME/skills` (rank 400) with the same name would silently win, so
  `services/gateway` refuses per-user skill names that exist here.
- `services/gateway` also reads the frontmatter here at startup to build the
  "/" menu (`GET /skills`).

## Frontmatter

`dsh-skill-filesystem` reads only `name`, `description`, `whenToUse`,
`metadata`, `disable-model-invocation`, `user-invocable`. Other keys are
ignored.

- `name` must be kebab-case.
- **Invocation keys must be kebab-case.** `userInvocable: false` (camelCase)
  drops the whole skill from discovery with only a log warning.
- `user-invocable: false` hides the skill from `/name`; the model can still
  load it with the `skill` tool.

## Writing skill bodies for fox

- Web search tool is `web_search` (Google results via Serper —
  packages/tool/serper-web-search). It takes a `queries` array.
- Today's date is in the system prompt's Environment section (packages/core).
- Refer to bundled files by relative path (`references/x.md`). When a skill is
  loaded, the model is told its base directory.
- There is no RLM/Python-REPL session. The `bash` tool is available inside the
  sandbox.

Origin: ported from agent-core `bundles/skills` — see
`docs/skill-transfer-plan.md`.
