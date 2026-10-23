// Entity operators (port of pynote-memory's operators.py, VikingMem §3.2): a property declares
// `aggregate: {op, event, field}`; each event of that type folds `event.properties[field]` into it. Statistics run in
// code, never in the model (small models add and average wrong). LLM_MERGE text is updated by patches (patch.ts).

export type Op = 'SET' | 'IMMUTABLE' | 'SUM' | 'COUNT' | 'MAX' | 'MIN' | 'AVG' | 'APPEND' | 'LLM_MERGE'

export const OPS: readonly Op[] = ['SET', 'IMMUTABLE', 'SUM', 'COUNT', 'MAX', 'MIN', 'AVG', 'APPEND', 'LLM_MERGE']

const empty = (value: unknown) => value === undefined || value === null || value === ''

/** "1.234,5" (vi) and "1,234.5" (en): the separator that comes last is the decimal one. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'boolean') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  let text = value.trim().replace(/\s+/g, '')
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '')
  } else if (text.includes(',')) {
    const tail = text.slice(text.lastIndexOf(',') + 1)
    const head = text.slice(0, text.lastIndexOf(','))
    text = tail.length !== 3 ? `${head.replace(/,/g, '')}.${tail}` : text.replace(/,/g, '')
  } else if ((text.match(/\./g) ?? []).length > 1 || ((text.match(/\./g) ?? []).length === 1 && text.slice(text.lastIndexOf('.') + 1).length === 3)) {
    text = text.replace(/\./g, '')
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return undefined
  const number = Number(text)
  return Number.isFinite(number) ? number : undefined
}

/**
 * Folds `incoming` into `current`. `aux` keeps side state (the count behind AVG). An invalid input (a number that
 * does not read for SUM/AVG, ...) keeps the old value. Returns [new value, new aux].
 */
export function applyOp(op: Op, current: unknown, aux: Record<string, unknown>, incoming: unknown): [unknown, Record<string, unknown>] {
  const state = { ...aux }
  switch (op) {
    case 'SET':
      return [empty(incoming) ? current : incoming, state]
    case 'IMMUTABLE':
      return [empty(current) ? incoming : current, state]
    case 'COUNT':
      return [Number(current ?? 0) + 1, state]
    case 'APPEND': {
      const items = Array.isArray(current) ? [...current] : []
      for (const item of Array.isArray(incoming) ? incoming : [incoming]) {
        if (!empty(item) && !items.includes(item)) items.push(item)
      }
      return [items, state]
    }
    case 'LLM_MERGE':
      // nothing to patch yet: the text is taken as it is
      return [empty(current) ? incoming : current, state]
  }
  const number = toNumber(incoming)
  if (number === undefined) return [current, state]
  switch (op) {
    case 'SUM':
      return [Number(current ?? 0) + number, state]
    case 'MAX':
      return [current === undefined || current === null ? number : Math.max(Number(current), number), state]
    case 'MIN':
      return [current === undefined || current === null ? number : Math.min(Number(current), number), state]
    case 'AVG': {
      const n = Number(state.n ?? 0)
      const total = Number(state.sum ?? 0) + number
      state.n = n + 1
      state.sum = total
      return [total / (n + 1), state]
    }
  }
  return [current, state]
}
