# @fox-harness/dsh-tool-create-skill

Tool `create_skill` — lets the model save a personal skill for the user from
inside a chat, after the user has approved the proposed content
(docs/skill-transfer-plan.md, giai đoạn 3).

**It does not save anything.** The worker never knows who the user is
(docs/code-rules.md §7), so this tool only validates:

- name is kebab-case, description ≤ 280 characters, content ≤ 64 KB;
- no skill with that name is visible in this session (built-in or the user's
  own — the user's skills are synced into `$DSH_HOME/skills`);
- the user has fewer than 50 skills of their own.

A successful call is the signal: `apps/web` (Conversation.tsx) sees the live
`tool/call` + successful `tool/result` for `create_skill` and saves the
arguments with `POST /custom-skills` as the signed-in user. Gateway stays the
authority (services/gateway/src/skills.ts) and syncs the new skill into every
open chat of that user.

Known trade-off: if the browser is closed at that exact moment, nothing is
saved. Replayed events (`snapshot` on reopening a chat) never trigger a save.

The proposal-first conversation flow lives in the tool description and in
`packages/skills/skill-creator`.
