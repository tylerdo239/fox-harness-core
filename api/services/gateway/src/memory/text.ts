// Text helpers shared by the memory (port of pynote-memory's textutil.py, docs/pynote-memory-reference.md).

export const CHARS_PER_TOKEN = 3.3

/** Lower case, no diacritics, đ → d, single spaces: how keys and search terms are compared. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/đ/g, 'd')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN)
}

export function hasVietnamese(text: string): boolean {
  return /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/.test(text.toLowerCase())
}

/** "0-3,7" → [0, 1, 2, 3, 7]; malformed parts are skipped; indices >= limit dropped. */
export function parseRanges(spec: string, limit?: number): number[] {
  const out = new Set<number>()
  for (const part of String(spec).replace(/\s+/g, '').split(',')) {
    if (!part) continue
    const range = /^(\d+)-(\d+)$/.exec(part)
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])]
      if (a <= b) for (let i = a; i <= b && i - a < 10_000; i++) out.add(i)
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part))
    }
  }
  return [...out].sort((a, b) => a - b).filter((i) => limit === undefined || i < limit)
}

/** [0, 1, 2, 3, 7] → "0-3,7". */
export function formatRanges(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b)
  const parts: string[] = []
  let start: number | undefined
  let prev: number | undefined
  for (const i of sorted) {
    if (start === undefined) {
      start = prev = i
    } else if (i === prev! + 1) {
      prev = i
    } else {
      parts.push(start === prev ? String(start) : `${String(start)}-${String(prev)}`)
      start = prev = i
    }
  }
  if (start !== undefined) parts.push(start === prev ? String(start) : `${String(start)}-${String(prev)}`)
  return parts.join(',')
}

/**
 * The words of `text` for the sparse (keyword) index: folded, split on anything that is not a letter or digit;
 * one-letter words dropped unless they are digits. Vietnamese syllables of two letters ("xa", "so", "bo") stay —
 * the reason this is on Qdrant and not MariaDB FULLTEXT (docs/memory-plugin-plan.md §5.2).
 */
export function terms(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 || /^\d$/.test(word))
}

/** FNV-1a, 32-bit: a term's index in the sparse vector space (collisions are rare and only add noise). */
export function termIndex(term: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < term.length; i++) {
    hash ^= term.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** A sparse vector for Qdrant: term frequencies of `text` (Qdrant applies IDF, `modifier: idf`). */
export function sparseVector(text: string): { indices: number[]; values: number[] } {
  const counts = new Map<number, number>()
  for (const term of terms(text)) {
    const index = termIndex(term)
    counts.set(index, (counts.get(index) ?? 0) + 1)
  }
  const indices = [...counts.keys()].sort((a, b) => a - b)
  return { indices, values: indices.map((i) => counts.get(i)!) }
}

/** The query side: each distinct term once. */
export function sparseQuery(text: string): { indices: number[]; values: number[] } {
  const indices = [...new Set(terms(text).map(termIndex))].sort((a, b) => a - b)
  return { indices, values: indices.map(() => 1) }
}
