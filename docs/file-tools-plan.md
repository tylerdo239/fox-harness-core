# Plan: dedicated file tools instead of `bash` (2026-10-22)

Status: **implemented 2026-10-22** (decisions D1–D4, §6). Where it lives:
- `api/packages/tool/file-manage/` — the `file_manage` tool (`src/index.ts`), its safe-fs copy with folder helpers,
  zip / unzip (`src/zip.ts`, Python's zipfile under the sandbox runner, no link ever followed);
- `api/packages/agent-core/src/transport/workspace-guard.ts` — the bash file-work rule (`onlyFileWork`) and the
  protected paths for write / edit / str_replace_editor;
- `flows.ts` (str_replace_editor hidden in default), `presets/default/agent.cordis.yml` (python);
- `app/.../Conversation.tsx` — file-tool pills in words; e2e `fileTools` in `scripts/e2e-backend.mjs`. Reference: the reference implementation (its file tools come from the same dsh packages
we use; its own additions are `packages/bundle-core/src/{access,file-manage,prompt}.ts`).

## 1. Where we are

| Flow | File tools today | Shell |
|---|---|---|
| `default` | `read`, `write`, `edit`, `str_replace_editor`, `glob`, `grep` (dsh-base) | `bash` + `job_*` |
| `data-analysis` | `read`, `write`, `glob`, `grep` (`edit` hidden, QA 2026-10-16) | none (`python` instead) |
| `data-studio` | none (`analyze_data` only) | none |

(`api/packages/agent-core/src/transport/flows.ts:21-32`.)

So the file tools exist already; what the model still needs `bash` for in the default flow is listing a folder
and moving / copying / deleting / zipping files, plus running programs. The reference implementation measured the same thing: the
remaining bash calls were `ls -la, mv, cp, rm, mkdir, unzip` (`file-manage.ts:4-6`), and it replaced them with
one tool, `file_manage`, and turned bash off for every user whose role has no shell.

Why it matters here more than in the reference:
- **`FOX_SANDBOX_MODE=none` (the k8s pod, see the sandbox decision) gives `bash` no isolation at all**
  (`api/docker/fox-noconfine.sh`: `cd` + env allow-list + prlimit). A `cat ../../users/<other>/...` or a
  `ls /data` reads other users' files. The in-process file tools *are* fenced (`transport/workspace-guard.ts`),
  bash is not — the guard cannot see inside a command line.
- Every bash call is a process spawn (60 s timeout, bwrap setup in strict mode); a `read` is in-process.
- The model writes better with `edit` (exact replace, read-before-edit check) than with `sed`/heredocs.

## 2. Goals / non-goals

Goals
1. Every everyday file operation goes through a dedicated tool, for users and admins alike.
2. `bash` stays for everyone (D1), but only as the last resort: for running a program no dedicated tool covers
   (a CLI, a build, `curl`…). A plain file operation sent to bash is refused with the tool to use instead.
3. Close the write gaps of the current fs tools (below, §4.3).
4. Smaller prompt: one edit tool, no prompt sections for hidden tools.

Non-goals: upgrading dsh (we stay on `0.1.1-rc.2`, which already ships `dsh-tool-fs`, `dsh-tool-fs-search` and
`dsh-fs-observation-policy`); `read_image` (stays hidden until image input is wired); file version history
(the reference's `file_history`, later if asked).

## 3. Tools after the change (default flow, every role)

| Tool | Source | Notes |
|---|---|---|
| `read` | dsh-tool-fs | line-numbered, 2000 lines / 50 KB per call, `offset`/`limit` |
| `write` | dsh-tool-fs | create / replace; read-before-overwrite (`fs-observation-policy`) |
| `edit` | dsh-tool-fs | exact unique match or `replace_all`; read first; CRLF kept |
| `glob` | dsh-tool-fs-search | ripgrep `--files`, 100 paths, mtime order |
| `grep` | dsh-tool-fs-search | ripgrep regex, 250 matches, `include` filter |
| **`file_manage`** (new) | `api/packages/tool/file-manage` | `list`, `mkdir`, `move`, `copy`, `delete` (to trash), `zip`, `unzip` |
| `python` (D2: yes) | python-repl | runs code, with its variables kept between calls and the memory limits |
| `bash`, `job_*` | dsh | last resort only (§4.1) |

Hidden: `str_replace_editor` (duplicates `edit`; two edit tools cost prompt and the model mixes them).

## 4. Work

### 4.1 Bash as the last resort (D1)
- Kept for user and admin, in every flow that has it today (default). data-analysis / data-studio unchanged.
- **Guard** in `workspace-guard.ts` (global, so subagents too): split the command on `;`, `&&`, `||`, `|` and
  newlines; when **every** part starts with a plain file command — `ls`, `cat`, `head`, `tail`, `less`, `wc`,
  `find`, `grep`, `rg`, `sed`, `awk` used on a file, `echo …>`, `printf …>`, `touch`, `mkdir`, `mv`, `cp`, `rm`,
  `zip`, `unzip`, `tar` — deny with the tool to use: *"Use read / glob / grep to look at files, edit / write to
  change them and file_manage to list, move, copy, delete or zip them. bash is for running programs no tool
  covers."* A command that also runs anything else passes (e.g. `npm test | tail`). It is a steering rule, not
  a security fence — the model can always wrap a file command in a script.
- **Prompt**: the bash section says the same, once (§4.4).
- **Security unchanged, and still the main risk:** with `FOX_SANDBOX_MODE=none` a bash (or python) command runs
  with no isolation, so it can read other users' files (`cat ../../users/<id>/…`). The steering rule above does
  not close that. Only the strict sandbox does (`docs/sandbox-service-plan.md`). Keep this in the staging
  checklist.

### 4.2 `file_manage` (new package)
Port of the reference's `file-manage.ts`, rewritten on our `safe-fs.ts` (copy #4 of it, keep
in step with the gateway one), so no step follows a symlink:
- Parameters: `action` (enum, required), `path`, `to`, `overwrite` (bool), `depth` (1–4, default 2).
- `list`: up to 300 entries, folders first, size + `YYYY-MM-DD HH:MM`, dot-entries hidden; marks uploaded
  sources `(read-only)`.
- `delete`: moves to `.fox/trash/<stamp>/<rel>` (restorable, the result says how). Entries older than 7 days are
  removed for good on the next file_manage call; Settings > Storage cleanup (`clearWorkspace`) and deleting the
  chat or project remove the whole trash. Never a real delete from the model.
- `move` / `copy`: no overwrite unless `overwrite: true`; no folder into itself.
- `zip` / `unzip`: fixed python script run **through the confine runner** (like canvas' `cat`), 120 s, max 2000
  entries / 500 MB, zip-slip refused, `__MACOSX` / `.DS_Store` skipped, cp437 names repaired.
- Refused for every action: `.fox/**`, `.canvas/**`, the uploaded sources (`.fox/sources.json`) as a source of
  `move`/`delete` or a target of anything, and in a project chat anything outside the chat's own output
  (`generated/<sid>/`, `outputs/`) as a target.
- After a change: `refreshDatasetCards` is the gateway's; the runtime only writes files — the turn-end
  `reconcileWorkspace` already files unowned output under `generated/<sid>/`.

### 4.3 Close the write gaps of the fs tools (guard)
1. **Uploaded originals can be replaced.** They are chmod 0444, but `write` publishes with a temp file +
   `rename` (`dsh-fs-local/lib/index.js:508`), which only needs the directory to be writable — a 0444 file
   is replaced. The guard must deny
   `write` / `edit` / `str_replace_editor` / `file_manage` on any path in `.fox/sources.json`.
2. `.fox/**` (manifests) and `.canvas/**` (panel history): deny every mutating tool.
3. Canvas files: deny `write` / `edit` with "use canvas_write" (the reference does the same; our QA 2026-10-16 hit it).
4. `grep` / `glob` with no `path` default to the cwd — fine; the guard already handles `path` and an absolute /
   `..` `pattern`. Add: reject a `path` that is a symlink to outside (covered by `realpathOrAncestor`) — test it.

### 4.4 Prompt
- One section (default flow): *"Use the dedicated tools, not shell commands: read / glob / grep instead of cat /
  ls / find / grep; edit / write instead of sed / echo > file; file_manage instead of mv / cp / rm / mkdir /
  zip / unzip."*
- Drop dsh's `tool:glob` / `tool:grep` sections if they only repeat the descriptions (measure the size first, as
  in 2026-10-16); keep `tool:read` / `tool:write` / `tool:edit` (they carry the read-before-write rule).

### 4.5 FE (`Conversation.tsx`)
`ToolPill` shows raw JSON today. Use the tools' `meta`:
- `read`: path + line range; `write` / `edit`: path + a small diff (dsh puts hunks in `meta`); `glob` / `grep`:
  pattern + count; `file_manage`: the action as a sentence ("Moved a.csv → archive/").
- Labels in `translations.ts` (vi / en).

### 4.6 Check before starting
- ripgrep: `dsh-tool-fs-search` uses the `@vscode/ripgrep` binary — confirm it is in `api/Dockerfile`'s image
  for linux/amd64 and arm64 (`rg --version` in the backend container).
- dsh `0.1.1-rc.2` vs the reference's `0.1.5`: confirm parameter names (`file_path`, `old_string`, `replace_all`) and
  messages in `node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js`; the plan does not depend on 0.1.5 features.

## 5. Tests (e2e, `scripts/e2e-backend.mjs`, mock LLM `CALL <tool> <json>`)
- `CALL bash {"command":"ls -la"}` / `cat a.csv | head` / `mv a b` → refused with the tool hint (user and admin);
  `python3 --version`, `node -e …`, `npm test | tail` → run.
- default flow has `python`; variables kept between two calls.
- `read` → `edit` → `read` round trip; `edit` without `read` → "has not been read"; ambiguous match error.
- `write` onto an uploaded source → refused, file unchanged (today: replaced — the test must fail first).
- `file_manage`: list, mkdir, move, copy, delete → in trash and restorable, zip / unzip incl. a zip-slip archive
  and a symlink inside the workspace pointing outside (refused).
- subagent: the same bash rule applies.
- both sandbox modes (`strict`, `none`).

## 6. Decisions (taken 2026-10-22)

| # | Question | Decision |
|---|---|---|
| D1 | Who keeps `bash`? | everyone, user and admin — only for programs no dedicated tool covers (§4.1) |
| D2 | Default flow gets the `python` tool? | yes |
| D3 | `str_replace_editor` | hide everywhere |
| D4 | data-analysis keeps `edit` hidden? | yes; it gets `file_manage` |
| D5 | Uploaded files in a chat of its own (not a project): editable? | no — read-only everywhere; a change is written to a new file (the original is kept) |

## 7. Size
Guard (bash rule + write gaps) + python in default + prompt: ~1 day. `file_manage` + tests: ~2 days. FE pills: ~1 day. No DB change.

## 8. Review 2026-10-22 (fixed)
An independent review plus a real-model run (9 everyday requests on the local stack: the model used `file_manage`,
`read`, `write`, `python` and recovered after the one `mkdir` it sent to bash) found and fixed:
- `overwrite: true` could replace an upload or a canvas version through a folder copy or an unzip: every written
  file is now checked (copy), the unzip script gets the protected list; canvas version names refused as targets;
  moving / deleting a folder that holds canvas versions refused.
- The trash was never emptied: 7-day purge + `clearWorkspace` includes it.
- zip read whole files into memory: streamed in 1 MB chunks; a failed zip / unzip leaves nothing behind (temporary
  archive renamed at the end, written files removed, SIGTERM unwinds first).
- bash rule: `xargs …` / `find -exec …` running a program, `<<<` here-strings, `tar`, and file commands on system
  paths outside the workspace (`cat /etc/os-release`) are no longer refused.
- Project chats may also write to `outputs/`; a trashed file is restored only into the chat it came from; `list`
  reads kinds from the folder (no lstat per entry); clearer errors (no `/proc/self/fd` paths).
