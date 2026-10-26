// docs/admin-usage-dashboard-plan.md — agent usage for the admin dashboard.
// 1. Ingest: every runtime appends records to <dataDir>/usage/shard-<n>/<YYYY-MM-DD>.jsonl (agent-core's
//    transport/usage-recorder.ts). A sweep here reads what is new in each file, adds the owner / flow / project from
//    discovery_sessions and inserts into discovery_usage_steps / discovery_usage_turns / discovery_usage_turn_tools (api/migrations/002_usage.sql).
//    `insert ignore` on unique keys: a crash between the insert and the saved offset re-reads lines that are then
//    ignored, never counted twice. Files older than a week and fully read are deleted; rows older than
//    USAGE_RETENTION_DAYS once a day.
// 2. Admin jobs (Data Studio's data profile, sync / reindex embeddings) run in the gateway's own Python worker, not in
//    a runtime: their model calls are inserted directly (recordAdminUsage).
// 3. The report (GET /admin/usage/report) and one user's chats (GET /admin/usage/users/:id): GROUP BY queries.
//    Days are counted at a fixed UTC offset (+07:00 by default).
import { randomUUID } from 'node:crypto'
import { open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { config } from '../config.ts'
import { dbBatch, dbQuery } from '../db.ts'
import { errorFields, log } from '../log.ts'

const DAY_MS = 86_400_000
const MAX_DAYS = 366
const READ_CHUNK = 4 * 1024 * 1024
const KEEP_FILES_DAYS = 7

const usageRoot = () => join(config.dataDir, 'usage')
const offsetMs = () => config.usage.utcOffsetMinutes * 60_000
/** `at` columns hold UTC; this shifts them to the report's local time inside SQL. */
const localAt = (column = 'at') => `(${column} + interval ${String(config.usage.utcOffsetMinutes)} minute)`

/** A UTC `datetime(3)` literal for MariaDB (the pool's own Date conversion would use the process time zone). */
function sqlTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

const int = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0)
const intOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null)
const text = (value: unknown, max: number, fallback = '') => (typeof value === 'string' && value !== '' ? value.slice(0, max) : fallback)

// ── 1. ingest ────────────────────────────────────────────────────────────────────────────────────────────────────

interface SessionInfo { ownerId: number; flow: string; projectId: string | null }

async function sessionInfo(ids: string[]): Promise<Map<string, SessionInfo>> {
  const found = new Map<string, SessionInfo>()
  if (ids.length === 0) return found
  const rows = await dbQuery<{ session_id: string; owner_id: number; flow: string; project_id: string | null }[]>(
    `select session_id, owner_id, flow, project_id from discovery_sessions where session_id in (${ids.map(() => '?').join(',')})`,
    ids,
  )
  for (const row of rows) found.set(row.session_id, { ownerId: row.owner_id, flow: row.flow, projectId: row.project_id })
  return found
}

let missingTablesLogged = false
const missingTable = (error: unknown) => (error as { code?: string; errno?: number }).code === 'ER_NO_SUCH_TABLE' || (error as { errno?: number }).errno === 1146

async function insertRecords(records: Record<string, unknown>[]): Promise<void> {
  const ids = [...new Set(records.map((r) => text(r.sessionId, 64)).filter(Boolean))]
  const info = await sessionInfo(ids)
  const steps: unknown[][] = []
  const turns: unknown[][] = []
  const turnTools: unknown[][] = []
  for (const r of records) {
    const sessionId = text(r.sessionId, 64)
    if (!sessionId || typeof r.t !== 'number') continue
    const owner = info.get(sessionId)
    const userId = owner?.ownerId ?? (Number(r.userId) || 0)
    const flow = owner?.flow ?? text(r.flow, 32, 'unknown')
    const projectId = owner?.projectId ?? null
    if (r.kind === 'step') {
      steps.push([
        sqlTime(r.t), int(r.ms), userId, sessionId, flow, projectId, text(r.model, 128, 'unknown'), int(r.turn), int(r.step),
        text(r.purpose, 16, 'turn'), text(r.outcome, 32, 'ok'), int(r.in), int(r.out), intOrNull(r.cacheRead), intOrNull(r.reasoning),
        r.estimated === true ? 1 : 0,
      ])
    } else if (r.kind === 'turn') {
      const tools = Array.isArray(r.tools)
        ? (r.tools as { name?: unknown; calls?: unknown; errors?: unknown }[])
            .filter((t) => typeof t.name === 'string')
            .slice(0, 100)
            .map((t) => ({ name: String(t.name).slice(0, 64), calls: int(t.calls), errors: int(t.errors) }))
        : []
      turns.push([
        sqlTime(r.t), int(r.ms), userId, sessionId, flow, projectId, int(r.turn), text(r.reason, 32, 'unknown'), int(r.steps),
        int(r.toolCalls ?? tools.reduce((sum, t) => sum + t.calls, 0)), int(r.toolErrors), int(r.attachments),
      ])
      const perTool = new Map<string, { calls: number; errors: number }>()
      for (const t of tools) {
        const sum = perTool.get(t.name) ?? { calls: 0, errors: 0 }
        perTool.set(t.name, { calls: sum.calls + t.calls, errors: sum.errors + t.errors })
      }
      for (const [name, t] of perTool) turnTools.push([sqlTime(r.t), sessionId, int(r.turn), name, t.calls, t.errors])
    }
  }
  if (steps.length > 0) {
    await dbBatch(
      `insert ignore into discovery_usage_steps (at, ms, user_id, session_id, flow, project_id, model, turn, step, purpose, outcome,
        input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, estimated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      steps,
    )
  }
  if (turns.length > 0) {
    await dbBatch(
      `insert ignore into discovery_usage_turns (at, ms, user_id, session_id, flow, project_id, turn, reason, steps, tool_calls,
        tool_errors, attachments) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      turns,
    )
  }
  if (turnTools.length > 0) {
    // `ignore`: a file read twice adds nothing (one row per turn and tool)
    await dbBatch(
      `insert ignore into discovery_usage_turn_tools (at, session_id, turn, tool, calls, errors) values (?, ?, ?, ?, ?, ?)`,
      turnTools,
    )
  }
}

/** Reads what is new in one file (complete lines only) and inserts it; returns the new offset. */
async function ingestFile(path: string, from: number): Promise<number> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    let offset = from
    while (offset < size) {
      const length = Math.min(READ_CHUNK, size - offset)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      const chunk = buffer.subarray(0, bytesRead)
      const end = chunk.lastIndexOf(0x0a) // a line still being written waits for the next sweep
      if (end < 0) break
      const records: Record<string, unknown>[] = []
      for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          records.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          log('usage_bad_line', { file: path })
        }
      }
      for (let i = 0; i < records.length; i += 500) await insertRecords(records.slice(i, i + 500))
      offset += end + 1
    }
    return offset
  } finally {
    await handle.close()
  }
}

let lastRetention = 0

export async function ingestUsage(now = Date.now()): Promise<{ files: number }> {
  let shards: string[]
  try {
    shards = (await readdir(usageRoot())).filter((name) => /^shard-\d+$/.test(name))
  } catch {
    return { files: 0 } // nothing recorded yet
  }
  const offsets = new Map((await dbQuery<{ file: string; read_offset: number }[]>(`select file, read_offset from discovery_usage_ingest`)).map((r) => [r.file, Number(r.read_offset)]))
  let files = 0
  for (const shard of shards) {
    for (const name of (await readdir(join(usageRoot(), shard))).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
      const key = `${shard}/${name}`
      const path = join(usageRoot(), shard, name)
      const done = offsets.get(key) ?? 0
      const { size } = await stat(path)
      if (size > done) {
        const offset = await ingestFile(path, done)
        await dbQuery(
          `insert into discovery_usage_ingest (file, read_offset, updated_at) values (?, ?, utc_timestamp()) on duplicate key update read_offset = values(read_offset), updated_at = values(updated_at)`,
          [key, offset],
        )
        files += 1
        if (offset < size) continue
      }
      // a week old and fully read: its records are in the database
      if (Date.parse(`${name.slice(0, 10)}T00:00:00Z`) < now - KEEP_FILES_DAYS * DAY_MS) {
        await rm(path, { force: true })
        await dbQuery(`delete from discovery_usage_ingest where file = ?`, [key])
      }
    }
  }
  if (config.usage.retentionDays > 0 && now - lastRetention > DAY_MS) {
    lastRetention = now
    const cutoff = sqlTime(now - config.usage.retentionDays * DAY_MS)
    await dbQuery(`delete from discovery_usage_steps where at < ?`, [cutoff])
    await dbQuery(`delete from discovery_usage_turns where at < ?`, [cutoff])
    await dbQuery(`delete from discovery_usage_turn_tools where at < ?`, [cutoff])
  }
  return { files }
}

async function sweep(): Promise<void> {
  try {
    await ingestUsage()
    missingTablesLogged = false
  } catch (error) {
    if (missingTable(error)) {
      if (!missingTablesLogged) log('usage_tables_missing', { hint: 'apply api/migrations/002_usage.sql', ...errorFields(error) })
      missingTablesLogged = true
      return
    }
    log('usage_ingest_failed', errorFields(error))
  }
}

let timer: NodeJS.Timeout | undefined
let running: Promise<void> | undefined

export function startUsageIngest(): void {
  if (!config.usage.enabled) return
  timer = setInterval(() => {
    running ??= sweep().finally(() => (running = undefined))
  }, config.usage.intervalMs)
  timer.unref()
}

/** On shutdown: the runtimes have flushed; load their last records. */
export async function stopUsageIngest(): Promise<void> {
  if (timer) clearInterval(timer)
  await running
  if (config.usage.enabled) await sweep()
}

// ── 2. admin jobs ────────────────────────────────────────────────────────────────────────────────────────────────

/** Model calls an admin job made in the gateway's Python worker (bridge/admin_runner.py's `usage`). Never throws. */
export async function recordAdminUsage(userId: number | undefined, calls: unknown): Promise<void> {
  if (!Array.isArray(calls) || calls.length === 0) return
  const now = Date.now()
  const sessionId = `admin-${randomUUID()}`
  const records = (calls as Record<string, unknown>[]).map((call, i) => ({
    kind: 'step', t: now - int(call.ms), ms: call.ms, sessionId, userId: userId ?? 0, flow: 'admin', turn: 0, step: i + 1,
    purpose: text(call.purpose, 16, 'data-profile'), model: call.model, outcome: call.ok === false ? 'error' : 'ok',
    in: call.in, out: call.out, cacheRead: call.cacheRead, reasoning: call.reasoning, estimated: false,
  }))
  await insertRecords(records).catch((error: unknown) => {
    if (!missingTable(error)) log('usage_admin_record_failed', errorFields(error))
  })
}

// ── 3. report ────────────────────────────────────────────────────────────────────────────────────────────────────

export type Group = 'day' | 'week' | 'month'

export interface UsageQuery { from: string; to: string; group: Group }

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/
/** YYYY-MM-DD and a real calendar day (2026-13-01 or 2026-02-30 are not). */
const DATE = { test: (value: string) => DATE_FORMAT.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value }

/** The local calendar day of `ms`, as YYYY-MM-DD. */
function localDay(ms: number): string {
  return new Date(ms + offsetMs()).toISOString().slice(0, 10)
}

/** Midnight (local) of `day`, in UTC epoch ms. */
function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - offsetMs()
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** `from` / `to` (YYYY-MM-DD, local days, inclusive) or `days` (default 30), `group`; to is clamped to today. */
export function parseUsageQuery(params: URLSearchParams, now = Date.now()): UsageQuery | { error: string } {
  const today = localDay(now)
  let to = params.get('to') ?? today
  let from = params.get('from') ?? ''
  if (!DATE.test(to)) return { error: 'to must be YYYY-MM-DD' }
  if (to > today) to = today
  if (from === '') {
    const days = Math.min(MAX_DAYS, Math.max(1, Number(params.get('days') ?? 30) || 30))
    from = addDays(to, -(days - 1))
  }
  if (!DATE.test(from)) return { error: 'from must be YYYY-MM-DD' }
  if (from > to) [from, to] = [to, from]
  if ((dayStart(to) - dayStart(from)) / DAY_MS + 1 > MAX_DAYS) return { error: `at most ${String(MAX_DAYS)} days` }
  const group = params.get('group')
  return { from, to, group: group === 'week' || group === 'month' ? group : 'day' }
}

function bucketSql(group: Group, column = 'at'): string {
  const local = localAt(column)
  if (group === 'month') return `date_format(${local}, '%Y-%m')`
  if (group === 'week') return `date_format(date_sub(date(${local}), interval weekday(${local}) day), '%Y-%m-%d')`
  return `date_format(${local}, '%Y-%m-%d')`
}

/** Every bucket key of the range, so a day with no use still shows (as zero). */
function bucketsOf(from: string, to: string, group: Group): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = []
  let day = from
  if (group === 'week') {
    const weekday = (new Date(`${from}T00:00:00Z`).getUTCDay() + 6) % 7 // Monday = 0
    day = addDays(from, -weekday)
  } else if (group === 'month') {
    day = `${from.slice(0, 7)}-01`
  }
  while (day <= to) {
    let next: string
    let key: string
    if (group === 'month') {
      const [y, m] = day.split('-').map(Number) as [number, number]
      next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
      key = day.slice(0, 7)
    } else {
      next = addDays(day, group === 'week' ? 7 : 1)
      key = day
    }
    out.push({ key, from: day < from ? from : day, to: addDays(next, -1) > to ? to : addDays(next, -1) })
    day = next
  }
  return out
}

export interface Totals {
  activeUsers: number
  chats: number
  turns: number
  completedTurns: number
  cancelledTurns: number
  failedTurns: number
  blockedTurns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  toolCalls: number
  toolErrors: number
  attachments: number
  avgTurnMs: number | null
  medianTurnMs: number | null
}

const emptyTotals = (): Totals => ({
  activeUsers: 0, chats: 0, turns: 0, completedTurns: 0, cancelledTurns: 0, failedTurns: 0, blockedTurns: 0,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, toolCalls: 0, toolErrors: 0, attachments: 0, avgTurnMs: null, medianTurnMs: null,
})

const FAILED = `reason not in ('completed', 'aborted', 'blocked')`
const n = (value: unknown) => Number(value ?? 0)

const TURN_COLUMNS = `count(*) turns, count(distinct user_id) users, count(distinct session_id) chats,
  sum(reason = 'completed') completed, sum(reason = 'aborted') cancelled, sum(${FAILED}) failed, sum(reason = 'blocked') blocked,
  sum(tool_calls) tool_calls, sum(tool_errors) tool_errors, sum(attachments) attachments,
  avg(case when reason = 'completed' then ms end) avg_ms`
const STEP_COLUMNS = `sum(input_tokens) input, sum(output_tokens) output, coalesce(sum(cache_read_tokens), 0) cache`

type TurnRow = { turns: unknown; users: unknown; chats: unknown; completed: unknown; cancelled: unknown; failed: unknown; blocked: unknown; tool_calls: unknown; tool_errors: unknown; attachments: unknown; avg_ms: unknown }
type StepRow = { input: unknown; output: unknown; cache: unknown }

function totalsFrom(turn: TurnRow | undefined, step: StepRow | undefined, median: number | null): Totals {
  const t = emptyTotals()
  if (turn) {
    Object.assign(t, {
      activeUsers: n(turn.users), chats: n(turn.chats), turns: n(turn.turns), completedTurns: n(turn.completed),
      cancelledTurns: n(turn.cancelled), failedTurns: n(turn.failed), blockedTurns: n(turn.blocked), toolCalls: n(turn.tool_calls),
      toolErrors: n(turn.tool_errors), attachments: n(turn.attachments),
      avgTurnMs: turn.avg_ms === null || turn.avg_ms === undefined ? null : Math.round(n(turn.avg_ms)),
    })
  }
  if (step) Object.assign(t, { inputTokens: n(step.input), outputTokens: n(step.output), cacheReadTokens: n(step.cache) })
  t.medianTurnMs = median
  return t
}

async function medianMs(start: string, end: string, where = '', params: unknown[] = []): Promise<number | null> {
  const [row] = await dbQuery<{ c: unknown }[]>(`select count(*) c from discovery_usage_turns where at >= ? and at < ? and reason = 'completed' ${where}`, [start, end, ...params])
  const count = n(row?.c)
  if (count === 0) return null
  const middle = Math.floor((count - 1) / 2)
  const rows = await dbQuery<{ ms: unknown }[]>(
    `select ms from discovery_usage_turns where at >= ? and at < ? and reason = 'completed' ${where} order by ms limit ? offset ?`,
    [start, end, ...params, count % 2 === 0 ? 2 : 1, middle],
  )
  const values = rows.map((r) => n(r.ms))
  return values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}

async function periodTotals(fromDay: string, toDay: string): Promise<Totals> {
  const start = sqlTime(dayStart(fromDay))
  const end = sqlTime(dayStart(addDays(toDay, 1)))
  const [turn] = await dbQuery<TurnRow[]>(`select ${TURN_COLUMNS} from discovery_usage_turns where at >= ? and at < ?`, [start, end])
  const [step] = await dbQuery<StepRow[]>(`select ${STEP_COLUMNS} from discovery_usage_steps where at >= ? and at < ?`, [start, end])
  return totalsFrom(turn, step, await medianMs(start, end))
}

export interface UsageReport {
  range: { from: string; to: string; days: number; group: Group; utcOffsetMinutes: number; previousFrom: string; previousTo: string }
  totals: Totals
  previous: Totals
  series: (Totals & { key: string; from: string; to: string })[]
  hours: number[]
  weekdays: number[]
  outcomes: { completed: number; cancelled: number; failed: number; blocked: number; kinds: { kind: string; count: number }[] }
  users: (Totals & { id: number; email: string | null; role: string | null; lastActiveAt: string | null })[]
  models: { model: string; input: number; output: number; calls: number }[]
  flows: { flow: string; turns: number; inputTokens: number; outputTokens: number }[]
  tools: { tool: string; calls: number; errors: number }[]
  purposes: { purpose: string; calls: number; inputTokens: number; outputTokens: number }[]
  dataStudio: { turns: number; inputTokens: number; outputTokens: number; embeddingTokens: number; profileTokens: number }
  overhead: { compactionTokens: number; failedCalls: number; estimatedCalls: number; cacheShare: number | null }
  since: string | null
}

export async function usageReport(query: UsageQuery): Promise<UsageReport> {
  const { from, to, group } = query
  const days = Math.round((dayStart(to) - dayStart(from)) / DAY_MS) + 1
  const previousTo = addDays(from, -1)
  const previousFrom = addDays(previousTo, -(days - 1))
  const start = sqlTime(dayStart(from))
  const end = sqlTime(dayStart(addDays(to, 1)))
  const range = [start, end]
  const bucket = bucketSql(group)

  const [totals, previous, turnSeries, stepSeries, hourRows, weekdayRows, kindRows, userTurns, userSteps, modelRows, flowTurns, flowSteps, toolRows, purposeRows, overheadRow, sinceRow] = await Promise.all([
    periodTotals(from, to),
    periodTotals(previousFrom, previousTo),
    dbQuery<(TurnRow & { k: string })[]>(`select ${bucket} k, ${TURN_COLUMNS} from discovery_usage_turns where at >= ? and at < ? group by k`, range),
    dbQuery<(StepRow & { k: string })[]>(`select ${bucket} k, ${STEP_COLUMNS} from discovery_usage_steps where at >= ? and at < ? group by k`, range),
    dbQuery<{ h: unknown; c: unknown }[]>(`select hour(${localAt()}) h, count(*) c from discovery_usage_turns where at >= ? and at < ? group by h`, range),
    dbQuery<{ d: unknown; c: unknown }[]>(`select weekday(${localAt()}) d, count(*) c from discovery_usage_turns where at >= ? and at < ? group by d`, range),
    dbQuery<{ reason: string; c: unknown }[]>(`select reason, count(*) c from discovery_usage_turns where at >= ? and at < ? and ${FAILED} group by reason order by c desc limit 10`, range),
    dbQuery<(TurnRow & { user_id: number; last: string | null })[]>(
      `select user_id, ${TURN_COLUMNS}, date_format(max(at), '%Y-%m-%dT%H:%i:%s.%fZ') last from discovery_usage_turns where at >= ? and at < ? group by user_id`, range),
    dbQuery<(StepRow & { user_id: number; last: string | null })[]>(
      `select user_id, ${STEP_COLUMNS}, date_format(max(at), '%Y-%m-%dT%H:%i:%s.%fZ') last from discovery_usage_steps where at >= ? and at < ? group by user_id`, range),
    dbQuery<{ model: string; input: unknown; output: unknown; calls: unknown }[]>(
      `select model, sum(input_tokens) input, sum(output_tokens) output, count(*) calls from discovery_usage_steps where at >= ? and at < ? group by model order by sum(input_tokens + output_tokens) desc limit 20`, range),
    dbQuery<{ flow: string; turns: unknown }[]>(`select flow, count(*) turns from discovery_usage_turns where at >= ? and at < ? group by flow`, range),
    dbQuery<{ flow: string; input: unknown; output: unknown }[]>(`select flow, sum(input_tokens) input, sum(output_tokens) output from discovery_usage_steps where at >= ? and at < ? group by flow`, range),
    dbQuery<{ tool: string; calls: unknown; errors: unknown }[]>(
      `select tool, sum(calls) calls, sum(errors) errors from discovery_usage_turn_tools
       where at >= ? and at < ? group by tool order by calls desc limit 20`, range),
    dbQuery<{ purpose: string; calls: unknown; input: unknown; output: unknown }[]>(
      `select purpose, count(*) calls, sum(input_tokens) input, sum(output_tokens) output from discovery_usage_steps where at >= ? and at < ? group by purpose`, range),
    dbQuery<{ failed: unknown; estimated: unknown; cache: unknown; cached_input: unknown }[]>(
      `select sum(outcome = 'error') failed, sum(estimated) estimated, coalesce(sum(cache_read_tokens), 0) cache,
         coalesce(sum(case when cache_read_tokens is not null then input_tokens end), 0) cached_input
       from discovery_usage_steps where at >= ? and at < ?`, range),
    dbQuery<{ since: string | null }[]>(`select date_format(min(at), '%Y-%m-%dT%H:%i:%s.%fZ') since from discovery_usage_turns`),
  ])

  const turnByKey = new Map(turnSeries.map((r) => [r.k, r]))
  const stepByKey = new Map(stepSeries.map((r) => [r.k, r]))
  const series = bucketsOf(from, to, group).map((b) => ({ ...totalsFrom(turnByKey.get(b.key), stepByKey.get(b.key), null), ...b }))

  const hours = Array.from({ length: 24 }, () => 0)
  for (const r of hourRows) hours[n(r.h)] = n(r.c)
  const weekdays = Array.from({ length: 7 }, () => 0)
  for (const r of weekdayRows) weekdays[n(r.d)] = n(r.c)

  // users: those who chatted and those whose only use was an admin job
  const ids = [...new Set([...userTurns.map((r) => r.user_id), ...userSteps.map((r) => r.user_id)])]
  const people = ids.length === 0 ? [] : await dbQuery<{ id: number; email: string; role: string }[]>(
    `select id, email, role from discovery_users where id in (${ids.map(() => '?').join(',')})`, ids)
  const person = new Map(people.map((p) => [p.id, p]))
  const stepsByUser = new Map(userSteps.map((r) => [r.user_id, r]))
  const users = ids.map((id) => {
    const turn = userTurns.find((r) => r.user_id === id)
    const step = stepsByUser.get(id)
    const last = [turn?.last, step?.last].filter((v): v is string => typeof v === 'string').sort().pop() ?? null
    return { ...totalsFrom(turn, step, null), id, email: person.get(id)?.email ?? null, role: person.get(id)?.role ?? null, lastActiveAt: last }
  }).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || b.turns - a.turns)

  const flowTokens = new Map(flowSteps.map((r) => [r.flow, r]))
  const flowNames = [...new Set([...flowTurns.map((r) => r.flow), ...flowSteps.map((r) => r.flow)])]
  const flows = flowNames.map((flow) => ({
    flow,
    turns: n(flowTurns.find((r) => r.flow === flow)?.turns),
    inputTokens: n(flowTokens.get(flow)?.input),
    outputTokens: n(flowTokens.get(flow)?.output),
  })).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))

  const purposes = purposeRows.map((r) => ({ purpose: r.purpose, calls: n(r.calls), inputTokens: n(r.input), outputTokens: n(r.output) }))
  const byPurpose = (p: string) => purposes.find((r) => r.purpose === p)
  const overhead = overheadRow[0]
  const cachedInput = n(overhead?.cached_input)

  return {
    range: { from, to, days, group, utcOffsetMinutes: config.usage.utcOffsetMinutes, previousFrom, previousTo },
    totals,
    previous,
    series,
    hours,
    weekdays,
    outcomes: {
      completed: totals.completedTurns, cancelled: totals.cancelledTurns, failed: totals.failedTurns, blocked: totals.blockedTurns,
      kinds: kindRows.map((r) => ({ kind: r.reason, count: n(r.c) })),
    },
    users,
    models: modelRows.map((r) => ({ model: r.model, input: n(r.input), output: n(r.output), calls: n(r.calls) })),
    flows,
    tools: toolRows.map((r) => ({ tool: r.tool, calls: n(r.calls), errors: n(r.errors) })),
    purposes,
    dataStudio: {
      turns: n(flowTurns.find((r) => r.flow === 'data-studio')?.turns),
      inputTokens: byPurpose('data-studio')?.inputTokens ?? 0,
      outputTokens: byPurpose('data-studio')?.outputTokens ?? 0,
      embeddingTokens: byPurpose('embedding')?.inputTokens ?? 0,
      profileTokens: (byPurpose('data-profile')?.inputTokens ?? 0) + (byPurpose('data-profile')?.outputTokens ?? 0),
    },
    overhead: {
      compactionTokens: (byPurpose('compaction')?.inputTokens ?? 0) + (byPurpose('compaction')?.outputTokens ?? 0),
      failedCalls: n(overhead?.failed),
      estimatedCalls: n(overhead?.estimated),
      cacheShare: cachedInput > 0 ? n(overhead?.cache) / cachedInput : null,
    },
    since: sinceRow[0]?.since ?? null,
  }
}

const cache = new Map<string, { at: number; value: Promise<UsageReport> }>()

/** One computation per (from, to, group) every 30 s: the page refreshes every minute, admins may be several. */
export function cachedUsageReport(query: UsageQuery): Promise<UsageReport> {
  const key = `${query.from}|${query.to}|${query.group}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < config.usage.reportCacheMs) return hit.value
  for (const [k, v] of cache) if (now - v.at >= config.usage.reportCacheMs) cache.delete(k)
  const started = now
  const value = usageReport(query).then((report) => {
    const ms = Date.now() - started
    if (ms > 1500) log('usage_report_slow', { ms, from: query.from, to: query.to, group: query.group })
    return report
  })
  value.catch(() => cache.delete(key))
  cache.set(key, { at: now, value })
  return value
}

export interface UserChat {
  sessionId: string
  title: string | null
  flow: string
  projectId: string | null
  turns: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  lastActiveAt: string | null
}

/** One user's chats in the period, most recent first, `limit` per page from `offset`. */
export async function userUsage(userId: number, query: UsageQuery, offset = 0, limit = 100): Promise<{ user: { id: number; email: string | null; role: string | null }; chats: UserChat[]; next: number | null }> {
  const start = sqlTime(dayStart(query.from))
  const end = sqlTime(dayStart(addDays(query.to, 1)))
  const [person] = await dbQuery<{ id: number; email: string; role: string }[]>(`select id, email, role from discovery_users where id = ?`, [userId])
  const rows = await dbQuery<{ session_id: string; flow: string; project_id: string | null; last: string | null; turns: unknown; input: unknown; output: unknown; tool_calls: unknown }[]>(
    `select s.session_id, max(s.flow) flow, max(s.project_id) project_id, date_format(max(s.at), '%Y-%m-%dT%H:%i:%s.%fZ') last,
       coalesce(max(t.turns), 0) turns, sum(s.input_tokens) input, sum(s.output_tokens) output, coalesce(max(t.tool_calls), 0) tool_calls
     from discovery_usage_steps s
     left join (select session_id, count(*) turns, sum(tool_calls) tool_calls from discovery_usage_turns where user_id = ? and at >= ? and at < ? group by session_id) t
       on t.session_id = s.session_id
     where s.user_id = ? and s.at >= ? and s.at < ?
     group by s.session_id order by max(s.at) desc limit ? offset ?`,
    [userId, start, end, userId, start, end, limit + 1, offset],
  )
  const page = rows.slice(0, limit)
  const titles = page.length === 0 ? [] : await dbQuery<{ session_id: string; title: string | null }[]>(
    `select session_id, title from discovery_sessions where session_id in (${page.map(() => '?').join(',')})`, page.map((r) => r.session_id))
  const titleOf = new Map(titles.map((t) => [t.session_id, t.title]))
  return {
    user: { id: userId, email: person?.email ?? null, role: person?.role ?? null },
    chats: page.map((r) => ({
      sessionId: r.session_id,
      title: titleOf.get(r.session_id) ?? null,
      flow: r.flow,
      projectId: r.project_id,
      turns: n(r.turns),
      inputTokens: n(r.input),
      outputTokens: n(r.output),
      toolCalls: n(r.tool_calls),
      lastActiveAt: r.last,
    })),
    next: rows.length > limit ? offset + limit : null,
  }
}
