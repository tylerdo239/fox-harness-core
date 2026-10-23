// Relative time phrases → absolute dates, in code, not by the model (port of pynote-memory's timeparse.py).
//
// The model only copies the phrase the member used ("tuần trước", "thứ Sáu tuần trước", "last Friday"); the date is
// worked out here from the day of the conversation (`anchor`). Measured by pynote with self-hosted Qwen on LOCOMO:
// left to the model, the conversion came out wrong ("yesterday (19 August 2023)" in a 25 August session) or was
// skipped, and "when" questions lost to Mem0 by more than 20 points.
//
//   resolveWhen('last Friday', utcDate(2023, 7, 15)) → 'last Friday (14 July 2023)'
//   resolveWhen('tuần trước', utcDate(2023, 6, 9))   → 'tuần trước (02/06–08/06/2023)'
//
// A phrase not recognised (already absolute, or unusual) is kept as is. A bracket the model added itself is dropped
// and worked out again when the phrase is recognised.
import { fold, hasVietnamese } from './text.ts'

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS_EN = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
// folded: "thu hai" … "chu nhat"; "thu 2" … "thu 7", "cn"
const WEEKDAYS_VI: [string, number][] = [
  ['thu hai', 0], ['thu 2', 0], ['thu ba', 1], ['thu 3', 1], ['thu tu', 2], ['thu 4', 2], ['thu nam', 3], ['thu 5', 3],
  ['thu sau', 4], ['thu 6', 4], ['thu bay', 5], ['thu 7', 5], ['chu nhat', 6], ['cn', 6],
]
const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, 'a couple of': 2, 'couple of': 2,
  mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10,
}
const NUM = '(\\d+|a couple of|couple of|an?|one|two|three|four|five|six|seven|eight|nine|ten|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)'
const ABSOLUTE = /\b(1[89]|20)\d\d\b|\b\d{1,2}[/-]\d{1,2}\b/
const DAY_MS = 86_400_000

const n = (word: string): number => (/^\d+$/.test(word) ? Number(word) : NUMBERS[word]!)

/** A calendar day at UTC midnight (month 1–12). */
export function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

const addDays = (d: Date, k: number): Date => new Date(d.getTime() + k * DAY_MS)
/** Monday = 0 … Sunday = 6, like Python's date.weekday(). */
const weekday = (d: Date): number => (d.getUTCDay() + 6) % 7
const mod = (a: number, b: number): number => ((a % b) + b) % b
const pad = (v: number): string => String(v).padStart(2, '0')

/** Output in the language of the phrase. */
class Out {
  constructor(private readonly vi: boolean) {}

  day(d: Date): string {
    return this.vi
      ? `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear())}`
      : `${String(d.getUTCDate())} ${MONTHS_EN[d.getUTCMonth()]!} ${String(d.getUTCFullYear())}`
  }

  span(a: Date, b: Date): string {
    const [ay, by] = [a.getUTCFullYear(), b.getUTCFullYear()]
    if (this.vi) return ay === by ? `${pad(a.getUTCDate())}/${pad(a.getUTCMonth() + 1)}–${this.day(b)}` : `${this.day(a)}–${this.day(b)}`
    if (ay !== by) return `${this.day(a)}–${this.day(b)}`
    if (a.getUTCMonth() !== b.getUTCMonth()) return `${String(a.getUTCDate())} ${MONTHS_EN[a.getUTCMonth()]!}–${this.day(b)}`
    return `${String(a.getUTCDate())}–${this.day(b)}`
  }

  month(year: number, month: number): string {
    return this.vi ? `tháng ${String(month)}/${String(year)}` : `${MONTHS_EN[month - 1]!} ${String(year)}`
  }

  year(year: number): string {
    return this.vi ? `năm ${String(year)}` : String(year)
  }

  before(anchor: Date): string {
    return this.vi ? `trước ${this.day(anchor)}` : `before ${this.day(anchor)}`
  }
}

function shiftMonth(year: number, month: number, delta: number): [number, number] {
  const index = year * 12 + (month - 1) + delta
  return [Math.floor(index / 12), mod(index, 12) + 1]
}

/** The weekday and the rest of the phrase without its name ("sáu" in "thứ Sáu" is not "sau"/6). */
function findWeekday(text: string): [number, string] | undefined {
  const names: [string, number][] = [...WEEKDAYS_EN.map((name, i): [string, number] => [name, i]), ...WEEKDAYS_VI]
  for (const [name, i] of names) {
    const re = new RegExp(`\\b${name}\\b`, 'g')
    if (re.test(text)) return [i, text.replace(re, ' ')]
  }
  return undefined
}

/** The absolute day or span of `phrase` counted from `anchor` (UTC midnight), or undefined when not recognised. */
export function resolve(phrase: string, anchor: Date): string | undefined {
  const out = new Out(hasVietnamese(phrase) || /\b(hom|tuan|thang|nam|ngay|thu|truoc|toi|sau|qua)\b/.test(fold(phrase)))
  const t = fold(phrase).trim()
  if (!t || ABSOLUTE.test(t)) return undefined
  const day = (k: number) => out.day(addDays(anchor, k))
  const wd = weekday(anchor)

  // days
  if (/\b(the )?day before yesterday\b|\bhom kia\b/.test(t)) return day(-2)
  if (/\byesterday\b|\blast night\b|\bhom qua\b|\btoi qua\b|\bdem qua\b/.test(t)) return day(-1)
  if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b|\bhom nay\b|\bsang nay\b|\bchieu nay\b|\btoi nay\b/.test(t)) return day(0)
  if (/\btomorrow\b|\bngay mai\b/.test(t)) return day(1)

  // N days / weeks / months / years ago | from now
  const past = new RegExp(`\\b${NUM} (days?|weeks?|months?|years?) (ago|before|earlier)\\b`).exec(t)
    ?? new RegExp(`(?<!thu )\\b${NUM} (ngay|tuan|thang|nam) (truoc|qua)\\b`).exec(t) // "thứ sáu tuần trước" ≠ "6 tuần trước"
  const future = past ? null : new RegExp(`\\bin ${NUM} (days?|weeks?|months?|years?)\\b`).exec(t)
    ?? new RegExp(`(?<!thu )\\b${NUM} (ngay|tuan|thang|nam) (toi|nua|sau)\\b`).exec(t)
  const hit = past ?? future
  if (hit) {
    const k = n(hit[1]!) * (future ? 1 : -1)
    const unit = hit[2]!
    if (unit.startsWith('day') || unit.startsWith('ngay')) return day(k)
    if (unit.startsWith('week') || unit.startsWith('tuan')) {
      const start = addDays(anchor, 7 * k - wd)
      return out.span(start, addDays(start, 6))
    }
    if (unit.startsWith('month') || unit.startsWith('thang')) return out.month(...shiftMonth(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, k))
    return out.year(anchor.getUTCFullYear() + k)
  }
  if (/\ba few (days|weeks|months) ago\b|\bvai (ngay|tuan|thang) truoc\b/.test(t)) return out.before(anchor) // no exact day

  // weekends
  const weekend = new RegExp(`\\b(last|past|this past) weekend\\b|\\bcuoi tuan (truoc|roi|qua)\\b|\\b${NUM} weekends? ago\\b`).exec(t)
  if (weekend) {
    const back = weekend[3] ? n(weekend[3]) : 1
    const saturday = addDays(anchor, -(mod(wd - 5, 7) || 7) - 7 * (back - 1)) // the last Saturday before anchor
    return out.span(saturday, addDays(saturday, 1))
  }
  if (/\bnext weekend\b|\bcuoi tuan (toi|sau|nay)\b|\bthis weekend\b/.test(t)) {
    const saturday = addDays(anchor, mod(5 - wd, 7) || 7)
    return out.span(saturday, addDays(saturday, 1))
  }

  // weekdays
  const found = findWeekday(t)
  if (found) {
    const [target, rest] = found
    if (/\bnext\b|\bthis coming\b|\b(tuan )?(toi|sau)\b/.test(rest)) return day(mod(target - wd, 7) || 7)
    let delta = mod(wd - target, 7) || 7 // the nearest one BEFORE anchor ("last Friday", "on Friday", "thứ Sáu")
    if (/\b(tuan truoc|tuan roi)\b/.test(rest) && delta < wd + 1) delta += 7 // "thứ Sáu tuần trước" when this week's has passed
    return day(-delta)
  }

  // weeks / months / years
  if (/\b(last|past|previous) week\b|\btuan (truoc|roi|qua)\b/.test(t)) return out.span(addDays(anchor, -7), addDays(anchor, -1))
  if (/\bthis week\b|\btuan nay\b/.test(t)) {
    const start = addDays(anchor, -wd)
    return out.span(start, addDays(start, 6))
  }
  if (/\bnext week\b|\btuan (toi|sau)\b/.test(t)) {
    const start = addDays(anchor, 7 - wd)
    return out.span(start, addDays(start, 6))
  }
  const [year, month] = [anchor.getUTCFullYear(), anchor.getUTCMonth() + 1]
  if (/\b(last|past|previous) month\b|\bthang (truoc|roi)\b/.test(t)) return out.month(...shiftMonth(year, month, -1))
  if (/\bthis month\b|\bthang nay\b/.test(t)) return out.month(year, month)
  if (/\bnext month\b|\bthang (toi|sau)\b/.test(t)) return out.month(...shiftMonth(year, month, 1))
  if (/\b(last|past|previous) year\b|\bnam (ngoai|truoc|roi)\b/.test(t)) return out.year(year - 1)
  if (/\bthis year\b|\bnam nay\b/.test(t)) return out.year(year)
  if (/\bnext year\b|\bnam (toi|sau)\b/.test(t)) return out.year(year + 1)
  if (/\b(recently|lately|the other day)\b|\bgan day\b|\bmoi day\b/.test(t)) return out.before(anchor)
  return undefined
}

const PAREN = /\s*\([^()]*\)\s*$/

/** A time property's value → "the phrase as said (absolute date)"; kept as is when not recognised. */
export function resolveWhen(value: unknown, anchor: Date): string {
  const text = String(value).trim()
  if (!text) return text
  const phrase = text.replace(PAREN, '').trim() || text // drop the model's own conversion, work it out again
  const resolved = resolve(phrase, anchor)
  return resolved === undefined ? text : `${phrase} (${resolved})`
}
