// Retrieval score (VikingMem §3.3; port of pynote-memory's ranking.py):
//   final = (1 - w_time - w_busi) · similarity + w_time · S_time + w_busi · S_busi
// S_time = 1 while "fresh", then halves every half-life; S_busi = the event type's weight × the event's importance.

export interface RankWeights {
  wTime: number
  wBusi: number
  freshDays: number
  halfLifeDays: number
}

export const DEFAULT_WEIGHTS: RankWeights = { wTime: 0.2, wBusi: 0.15, freshDays: 1, halfLifeDays: 30 }

export function timeScore(created: Date, now: Date, w: RankWeights = DEFAULT_WEIGHTS): number {
  const ageDays = Math.max(0, (now.getTime() - created.getTime()) / 86_400_000)
  if (ageDays <= w.freshDays) return 1
  return 0.5 ** ((ageDays - w.freshDays) / w.halfLifeDays)
}

export function finalScore(similarity: number, created: Date, business: number, now: Date, w: RankWeights = DEFAULT_WEIGHTS): number {
  const sim = Math.min(1, Math.max(0, similarity))
  const busi = Math.min(1, Math.max(0, business))
  return (1 - w.wTime - w.wBusi) * sim + w.wTime * timeScore(created, now, w) + w.wBusi * busi
}

export function parseTime(value: string | null | undefined): Date {
  if (!value) return new Date()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}
