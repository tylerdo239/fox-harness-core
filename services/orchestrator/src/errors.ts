// Distinguished from a plain Error so index.ts's HTTP handler can answer 429
// instead of 500 — a quota rejection is a normal, expected outcome under
// load, not a server fault.
export class QuotaExceededError extends Error {}

// Phase 12 item 4: a caller named a `model` that isn't in
// config.allowedModels — a client bug (stale/tampered picker), not a server
// fault, so index.ts answers 400 for this one specifically.
export class InvalidModelError extends Error {}
