-- Per-session flow/agent-loop choice (docs/data-analysis-flow-plan.md).
-- Mirrors how `model` is chosen once at session-creation time and carried
-- unchanged through every rehydrate (services/orchestrator's Redis record,
-- not this column, is the operational source of truth for a running
-- session — this column exists so the gateway/DB side also remembers which
-- flow a session was created with, e.g. for display or future filtering).
-- 'default' for every pre-existing row — the flow that was the only one
-- available before this column existed.
alter table sessions add column flow varchar(64) not null default 'default';
