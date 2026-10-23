// Broken tool calls: repair what can be repaired, report what cannot.
//
// Ported from examples/pynote-be (measured there on Qwen3.5-35B on vLLM, 2026-10-05/06):
//   - a `write` of a ~7k-token report ran out of room mid-JSON (finish
//     "length"); the arguments were cut off ("…\"content\": \"# Báo cáo\\n…"),
//     the tool answered "invalid arguments", and the NEXT request died with
//     400 "Unterminated string starting at: line 1 column 34" — vLLM parses
//     every past tool call's arguments when it renders the chat template, so
//     one bad call in history poisons every later request of the session;
//   - a `data_query` call came back with ChatML markup inside the JSON keys:
//     {"\n<parameter=save_as": "x.xlsx", "save_as": "x.xlsx", "sql": "…"},
//     and the turn ended with no answer.
//
// translate.ts runs `repairToolCall` on every call once a response is
// complete; what still is not a JSON object fails the attempt with a code
// dsh-llm-retry re-runs (adapter.ts providerRetryPolicy), or with
// CONTEXT_WINDOW_EXCEEDED when the output ran out of room, so compaction makes
// space first. serialize.ts runs `wireArguments` on history, so a session
// that already holds a broken call (from before this file) works again.

/** Failure code for a response whose tool call stays unusable after repair; retried by dsh-llm-retry. */
export const MALFORMED_TOOL_CALL_CODE = 'MALFORMED_TOOL_CALL'

const PARAMETER_MARKUP = /<parameter=([A-Za-z0-9_]+)>([\s\S]*?)(?:<\/parameter>|$)/g

/** "\n<parameter=save_as" → "save_as"; a normal key comes back unchanged. */
function cleanKey(key: string): string {
  const markup = /<parameter=([A-Za-z0-9_]+)>?/.exec(key)
  if (markup?.[1] !== undefined) return markup[1]
  return key.trim()
}

/** Markup carries every argument as text; tool schemas do not accept "10" for a number. */
function coerce(raw: string): unknown {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value !== '' && Number.isFinite(Number(value))) return Number(value)
  return value
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** A tool name with markup around it ("<function=bash>", "bash</function>") → "bash". */
export function cleanToolName(name: string): string {
  const stripped = name.replace(/<\/?function=?|<\/?tool_call>|[<>]/g, ' ').trim()
  return /[A-Za-z0-9_.:-]+/.exec(stripped)?.[0] ?? name.trim()
}

export interface RepairResult {
  /** Arguments as a JSON object string, when usable. */
  readonly arguments?: string
  readonly name: string
  /** What was fixed, for the log. */
  readonly fixes: readonly string[]
}

export function repairToolCall(name: string, rawArguments: string): RepairResult {
  const fixes: string[] = []
  const cleanName = cleanToolName(name)
  if (cleanName !== name) fixes.push(`name ${JSON.stringify(name)} → ${cleanName}`)
  const text = rawArguments.trim()
  if (text === '') return { arguments: '{}', name: cleanName, fixes: [...fixes, 'empty arguments → {}'] }

  const parsed = parseObject(text)
  if (parsed !== undefined) {
    const keys = Object.keys(parsed)
    if (!keys.some(key => cleanKey(key) !== key)) return { arguments: text, name: cleanName, fixes }
    // Clean keys win over markup-polluted duplicates of themselves.
    const out: Record<string, unknown> = {}
    for (const key of keys) if (cleanKey(key) === key) out[key] = parsed[key]
    for (const key of keys) {
      const clean = cleanKey(key)
      if (clean !== key && !(clean in out)) out[clean] = parsed[key]
    }
    return { arguments: JSON.stringify(out), name: cleanName, fixes: [...fixes, `markup in keys: ${keys.filter(key => cleanKey(key) !== key).map(key => JSON.stringify(key)).join(', ')}`] }
  }

  // Arguments written as ChatML markup instead of JSON.
  if (text.includes('<parameter=')) {
    const out: Record<string, unknown> = {}
    for (const [, key, value] of text.matchAll(PARAMETER_MARKUP)) if (key !== undefined && !(key in out)) out[key] = coerce(value ?? '')
    if (Object.keys(out).length > 0) return { arguments: JSON.stringify(out), name: cleanName, fixes: [...fixes, 'markup arguments → JSON'] }
  }
  return { name: cleanName, fixes }
}

/** Arguments safe to send back in history: the repaired JSON, else "{}" (the tool's own error result already told the model). */
export function wireArguments(name: string, rawArguments: string): string {
  return repairToolCall(name, rawArguments).arguments ?? '{}'
}
