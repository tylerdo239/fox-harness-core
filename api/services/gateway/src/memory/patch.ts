// Text properties (ChatBrief.summary) are updated by a SEARCH/REPLACE patch from the extraction itself, no second
// model call (VikingMem's EUA; port of pynote-memory's patch.py). Models copy a few characters wrong (punctuation,
// spaces, Vietnamese marks), so the span to replace is found by approximate matching.
import { fold } from './text.ts'

/** Below this the span is "not found": the replacement is appended instead of overwriting the wrong place. */
export const MIN_SIMILARITY = 0.8

/** difflib.SequenceMatcher(None, a, b, autojunk=False).ratio(): 2·M / (|a| + |b|), M = Ratcliff/Obershelp matches. */
export function similarity(a: string, b: string): number {
  const total = a.length + b.length
  if (total === 0) return 1
  return (2 * matchingCharacters(a, 0, a.length, b, 0, b.length)) / total
}

function matchingCharacters(a: string, alo: number, ahi: number, b: string, blo: number, bhi: number): number {
  if (alo >= ahi || blo >= bhi) return 0
  // longest common substring of a[alo:ahi] and b[blo:bhi] (leftmost in a, then in b, as difflib's find_longest_match)
  let bestI = alo
  let bestJ = blo
  let bestSize = 0
  let previous = new Map<number, number>()
  for (let i = alo; i < ahi; i++) {
    const current = new Map<number, number>()
    for (let j = blo; j < bhi; j++) {
      if (a[i] !== b[j]) continue
      const size = (previous.get(j - 1) ?? 0) + 1
      current.set(j, size)
      if (size > bestSize) {
        bestI = i - size + 1
        bestJ = j - size + 1
        bestSize = size
      }
    }
    previous = current
  }
  if (bestSize === 0) return 0
  return (
    bestSize +
    matchingCharacters(a, alo, bestI, b, blo, bestJ) +
    matchingCharacters(a, bestI + bestSize, ahi, b, bestJ + bestSize, bhi)
  )
}

/** The span [i, j) of `text` most like `needle`, and how alike (exact and unique first, else sliding windows). */
export function bestSpan(text: string, needle: string): [number, number, number] {
  if (!needle.trim() || !text) return [-1, -1, 0]
  const exact = text.indexOf(needle)
  // exact only when unique: two identical places do not say which one to replace
  if (exact >= 0 && text.indexOf(needle, exact + 1) < 0) return [exact, exact + needle.length, 1]
  const foldedNeedle = fold(needle)
  let best: [number, number, number] = [-1, -1, 0]
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (' \n.;,'.includes(text[i]!)) starts.push(i + 1)
  const target = needle.length
  const lengths = [...new Set([target - Math.floor(target / 5), target, target + Math.floor(target / 5)])]
  for (const start of starts) {
    for (const length of lengths) {
      const end = Math.min(text.length, start + Math.max(1, length))
      const score = similarity(fold(text.slice(start, end)), foldedNeedle)
      if (score > best[2]) best = [start, end, score]
    }
  }
  return best
}

/** Applies a patch: [new text, whether the span was found and replaced]. An empty `search` appends. */
export function applyPatch(old: string | undefined, search: string | undefined, replace: string): [string, boolean] {
  const current = old ?? ''
  const addition = replace.trim()
  if (!search || !search.trim()) return [current ? `${current.trimEnd()}\n${addition}`.trim() : addition, false]
  const [i, j, score] = bestSpan(current, search)
  if (i < 0 || score < MIN_SIMILARITY) return [`${current.trimEnd()}\n${addition}`.trim(), false]
  return [`${current.slice(0, i)}${addition}${current.slice(j)}`.trim(), true]
}
