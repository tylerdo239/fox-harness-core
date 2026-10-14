// The gateway's one log line format. JSON by default (one object per line, for a log collector);
// LOG_FORMAT=text prints the same fields as a line a person can read in `kubectl logs`:
//   2026-10-14T03:12:09.120Z ERROR s3_failed op=HeadBucket bucket=fox-skills status=403 error="..." hint="..."
// A line is an error when it carries an `error` field, unless `level` says otherwise.

const TEXT = (process.env.LOG_FORMAT ?? '').toLowerCase() === 'text'

export type Level = 'info' | 'warn' | 'error'

export function log(event: string, fields: Record<string, unknown> = {}, level?: Level): void {
  const lvl = level ?? (fields.error !== undefined ? 'error' : 'info')
  const ts = new Date().toISOString()
  if (!TEXT) {
    console.log(JSON.stringify({ ts, level: lvl, service: 'gateway', event, ...fields }))
    return
  }
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${textValue(value)}`)
  console.log([ts, lvl.toUpperCase().padEnd(5), event, ...parts].join(' '))
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return /^[\w.:/@-]+$/.test(value) ? value : JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  return JSON.stringify(value)
}

type DetailedError = Error & {
  code?: string
  $metadata?: { httpStatusCode?: number; requestId?: string; extendedRequestId?: string }
  cause?: unknown
}

const BUG = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'])

/**
 * What a log line needs to know about an error, spread into its fields: `...errorFields(error)`.
 * Keeps what String(error) drops: the HTTP status and request id of an AWS SDK error (a HEAD request has no body,
 * so its message is only "UnknownError"), the network code under a fetch failure (ECONNREFUSED, ENOTFOUND, ...),
 * and a short stack for a programming error.
 */
export function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) }
  const e = error as DetailedError
  const cause = e.cause instanceof Error ? (e.cause as DetailedError) : undefined
  const status = e.$metadata?.httpStatusCode
  const fields: Record<string, unknown> = {
    error: e.message === 'UnknownError' && status ? `HTTP ${status} with no error body` : e.message,
    errorName: e.name,
    errorCode: e.code ?? cause?.code,
    status,
    requestId: e.$metadata?.requestId,
    cause: cause?.message,
  }
  if (BUG.has(e.name) && e.stack) fields.stack = e.stack.split('\n').slice(1, 4).map((line) => line.trim()).join(' | ')
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key]
  return fields
}
