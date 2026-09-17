// Semantic-layer admin CRUD (docs/data-studio-admin-ui-plan.md) — reads and
// writes the SAME sqlite file `packages/tool/data-studio-agent/python`'s
// pipeline reads at query time (`config.dataStudioSharedDir`, the exact host
// directory services/orchestrator/src/docker.ts bind-mounts into every
// worker container as `/data-studio-shared`). Plain CRUD only: no Dremio
// call happens here (import/sync needs the real DremioClient — Python,
// spawned as its own subprocess bridge, not this file). `better-sqlite3`,
// same "one focused client per real protocol" choice as `mariadb`/`ioredis`
// elsewhere in this service — synchronous API is fine here: these are small
// single-row/small-table admin operations, not the hot chat path.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'

import { config } from './config.ts'

const dbPath = `${config.dataStudioSharedDir}/semantic_layer.db`
mkdirSync(dirname(dbPath), { recursive: true })
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

// Real bug found the hard way: SQLModel/SQLAlchemy's default `Enum` column
// type stores a Python enum's MEMBER NAME ("COUNT", "LEFT", "ONE_TO_MANY") —
// confirmed against rows the vendored Python sync code itself wrote
// (`data_sources.status` = "CONNECTED", `entities.entity_type` = "TABLE"),
// NOT the enum's `.value` ("count", "left", "1:N") this app's own FE
// dropdowns use. Writing the lowercase value directly (what every route
// below did before this was caught) makes SQLModel's own reads on the
// Python side raise `LookupError` the moment `reindex_all`/`run_pipeline_v3`
// touches that row — confirmed with a real "'count' is not among the
// defined enum values" crash. `src/database/models/enums.py` is the real
// source of truth for every one of these maps.
function enumNameFor(map: Record<string, string>, value: string): string {
  return map[value] ?? value
}
function enumValueFor(map: Record<string, string>, name: string | null): string | null {
  if (name === null) return null
  const entry = Object.entries(map).find(([, memberName]) => memberName === name)
  return entry ? entry[0] : name
}

const CARDINALITY_NAME: Record<string, string> = { '1:1': 'ONE_TO_ONE', '1:N': 'ONE_TO_MANY', 'N:N': 'MANY_TO_MANY' }
const JOIN_TYPE_NAME: Record<string, string> = { inner: 'INNER', left: 'LEFT' }
const AGGREGATION_NAME: Record<string, string> = {
  sum: 'SUM', avg: 'AVG', count: 'COUNT', count_distinct: 'COUNT_DISTINCT', min: 'MIN', max: 'MAX',
}
const ROLE_NAME: Record<string, string> = { dimension: 'DIMENSION', measure: 'MEASURE', key: 'KEY' }
const SEMANTIC_TYPE_NAME: Record<string, string> = {
  currency: 'CURRENCY', date: 'DATE', datetime: 'DATETIME', category: 'CATEGORY', id: 'ID',
  percent: 'PERCENT', count: 'COUNT', text: 'TEXT', pii: 'PII', boolean: 'BOOLEAN',
}

// The Python side (`src/database/engine.py`) owns `SQLModel.metadata.create_all()`
// and is the schema's real source of truth; gateway never creates tables —
// it only reads/writes rows in tables that already exist by the time an
// admin route is actually called (the pipeline creates them on its own first
// run). A query against a genuinely missing table surfaces as a real 500,
// not a silent empty result — visible enough that "the bridge hasn't been
// run yet" is diagnosable instead of masked.

export interface DataSourceRow {
  id: number
  name: string
  source_type: string
  dremio_path: string
  status: string
  last_synced_at: string | null
  is_exposed_to_agent: number
}

export function listDataSources(): DataSourceRow[] {
  return db.prepare('SELECT * FROM data_sources ORDER BY name').all() as DataSourceRow[]
}

export function getDataSource(id: number): DataSourceRow | undefined {
  return db.prepare('SELECT * FROM data_sources WHERE id = ?').get(id) as DataSourceRow | undefined
}

export function updateDataSource(id: number, input: { is_exposed_to_agent?: boolean }): DataSourceRow | undefined {
  if (!('is_exposed_to_agent' in input)) return getDataSource(id)
  db.prepare('UPDATE data_sources SET is_exposed_to_agent = ? WHERE id = ?').run(input.is_exposed_to_agent ? 1 : 0, id)
  return getDataSource(id)
}

export interface EntityRow {
  id: number
  data_source_id: number
  physical_path: string
  physical_name: string
  entity_type: string
  is_deprecated: number
  display_name: string
  description: string | null
  synonyms: string
  grain_description: string | null
  is_exposed: number
  is_pii: number
  row_count_est: number | null
}

export function listEntitiesForSource(dataSourceId: number): EntityRow[] {
  return db
    .prepare('SELECT * FROM entities WHERE data_source_id = ? ORDER BY physical_name')
    .all(dataSourceId) as EntityRow[]
}

export function getEntity(id: number): EntityRow | undefined {
  return db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined
}

export interface EntityUpdateInput {
  display_name?: string
  description?: string | null
  synonyms?: string[]
  grain_description?: string | null
  is_exposed?: boolean
  is_pii?: boolean
}

const ENTITY_UPDATABLE_FIELDS = ['display_name', 'description', 'synonyms', 'grain_description', 'is_exposed', 'is_pii'] as const

export function updateEntity(id: number, input: EntityUpdateInput): EntityRow | undefined {
  const sets: string[] = []
  const values: unknown[] = []
  for (const field of ENTITY_UPDATABLE_FIELDS) {
    if (!(field in input)) continue
    sets.push(`${field} = ?`)
    const value = input[field as keyof EntityUpdateInput]
    values.push(field === 'synonyms' ? JSON.stringify(value ?? []) : typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  if (sets.length === 0) return getEntity(id)
  values.push(id)
  db.prepare(`UPDATE entities SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getEntity(id)
}

export interface EntityColumnRow {
  id: number
  entity_id: number
  physical_name: string
  data_type: string
  ordinal: number
  is_nullable: number
  is_deprecated: number
  display_name: string
  description: string | null
  synonyms: string
  role: string | null
  semantic_type: string | null
  default_aggregation: string | null
  value_glossary: string
  is_exposed: number
  is_pii: number
  is_default_select: number
  distinct_count: number | null
  sample_values: string
  min_val: string | null
  max_val: string | null
  null_ratio: number | null
}

// Undoes enumNameFor() on the 3 enum columns this table has — the FE (and
// this file's own external contract) always sees lowercase values, never
// the stored SQLAlchemy member names.
function denormalizeColumnRow(row: EntityColumnRow): EntityColumnRow {
  return {
    ...row,
    role: enumValueFor(ROLE_NAME, row.role),
    semantic_type: enumValueFor(SEMANTIC_TYPE_NAME, row.semantic_type),
    default_aggregation: enumValueFor(AGGREGATION_NAME, row.default_aggregation),
  }
}

export function listColumnsForEntity(entityId: number): EntityColumnRow[] {
  return (
    db.prepare('SELECT * FROM entity_columns WHERE entity_id = ? ORDER BY ordinal').all(entityId) as EntityColumnRow[]
  ).map(denormalizeColumnRow)
}

export function getEntityColumn(id: number): EntityColumnRow | undefined {
  const row = db.prepare('SELECT * FROM entity_columns WHERE id = ?').get(id) as EntityColumnRow | undefined
  return row && denormalizeColumnRow(row)
}

export interface EntityColumnUpdateInput {
  display_name?: string
  description?: string | null
  synonyms?: string[]
  role?: string | null
  semantic_type?: string | null
  default_aggregation?: string | null
  is_exposed?: boolean
  is_pii?: boolean
  is_default_select?: boolean
}

const COLUMN_UPDATABLE_FIELDS = [
  'display_name', 'description', 'synonyms', 'role', 'semantic_type',
  'default_aggregation', 'is_exposed', 'is_pii', 'is_default_select',
] as const

export function updateEntityColumn(id: number, input: EntityColumnUpdateInput): EntityColumnRow | undefined {
  const sets: string[] = []
  const values: unknown[] = []
  for (const field of COLUMN_UPDATABLE_FIELDS) {
    if (!(field in input)) continue
    sets.push(`${field} = ?`)
    const value = input[field as keyof EntityColumnUpdateInput]
    values.push(
      field === 'synonyms'
        ? JSON.stringify(value ?? [])
        : typeof value === 'boolean'
          ? (value ? 1 : 0)
          : field === 'role' && typeof value === 'string'
            ? enumNameFor(ROLE_NAME, value)
            : field === 'semantic_type' && typeof value === 'string'
              ? enumNameFor(SEMANTIC_TYPE_NAME, value)
              : field === 'default_aggregation' && typeof value === 'string'
                ? enumNameFor(AGGREGATION_NAME, value)
                : value,
    )
  }
  if (sets.length === 0) return getEntityColumn(id)
  values.push(id)
  db.prepare(`UPDATE entity_columns SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getEntityColumn(id)
}

// ---- Glossary (docs/data-studio-admin-ui-plan.md phase 2) — flat CRUD, no
// Dremio dependency, unlike Data Sources above. ----

export interface GlossaryTermRow {
  id: number
  term: string
  synonyms: string
  definition_text: string
  sql_expressions: string
  related_entity_ids: string
}

export function listGlossaryTerms(): GlossaryTermRow[] {
  return db.prepare('SELECT * FROM business_glossary ORDER BY term').all() as GlossaryTermRow[]
}

export function getGlossaryTerm(id: number): GlossaryTermRow | undefined {
  return db.prepare('SELECT * FROM business_glossary WHERE id = ?').get(id) as GlossaryTermRow | undefined
}

export interface GlossaryTermInput {
  term: string
  synonyms?: string[]
  definition_text: string
  sql_expressions?: string[]
  related_entity_ids?: number[]
}

export function createGlossaryTerm(input: GlossaryTermInput): GlossaryTermRow {
  const result = db
    .prepare('INSERT INTO business_glossary (term, synonyms, definition_text, sql_expressions, related_entity_ids) VALUES (?, ?, ?, ?, ?)')
    .run(
      input.term,
      JSON.stringify(input.synonyms ?? []),
      input.definition_text,
      JSON.stringify(input.sql_expressions ?? []),
      JSON.stringify(input.related_entity_ids ?? []),
    )
  return getGlossaryTerm(Number(result.lastInsertRowid))!
}

const GLOSSARY_UPDATABLE_FIELDS = ['term', 'synonyms', 'definition_text', 'sql_expressions', 'related_entity_ids'] as const

export function updateGlossaryTerm(id: number, input: Partial<GlossaryTermInput>): GlossaryTermRow | undefined {
  const sets: string[] = []
  const values: unknown[] = []
  for (const field of GLOSSARY_UPDATABLE_FIELDS) {
    if (!(field in input)) continue
    sets.push(`${field} = ?`)
    const value = input[field as keyof GlossaryTermInput]
    values.push(field === 'term' || field === 'definition_text' ? value : JSON.stringify(value ?? []))
  }
  if (sets.length === 0) return getGlossaryTerm(id)
  values.push(id)
  db.prepare(`UPDATE business_glossary SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getGlossaryTerm(id)
}

export function deleteGlossaryTerm(id: number): boolean {
  return db.prepare('DELETE FROM business_glossary WHERE id = ?').run(id).changes > 0
}

// ---- Relationships (docs/data-studio-admin-ui-plan.md phase 3) — depends on
// entities/columns already synced (Data Sources, phase 1). ----

export interface BrowseEntity {
  id: number
  display_name: string
  physical_name: string
  data_source_id: number
  columns: { id: number; display_name: string; physical_name: string }[]
}

// For the relationship-builder's entity/column pickers — every entity across
// every data source, its columns nested. Small tables in practice (one
// semantic layer, not per-tenant), so one full scan + in-memory group is
// simpler than a real paginated join and fast enough.
export function listBrowseEntities(): BrowseEntity[] {
  const entities = db
    .prepare('SELECT id, display_name, physical_name, data_source_id FROM entities ORDER BY display_name')
    .all() as Omit<BrowseEntity, 'columns'>[]
  const columns = db
    .prepare('SELECT id, entity_id, display_name, physical_name FROM entity_columns ORDER BY ordinal')
    .all() as { id: number; entity_id: number; display_name: string; physical_name: string }[]
  const columnsByEntity = new Map<number, BrowseEntity['columns']>()
  for (const { entity_id, ...column } of columns) {
    const list = columnsByEntity.get(entity_id)
    if (list) list.push(column)
    else columnsByEntity.set(entity_id, [column])
  }
  return entities.map((entity) => ({ ...entity, columns: columnsByEntity.get(entity.id) ?? [] }))
}

export interface RelationshipColumnPairView {
  from_column_id: number
  to_column_id: number
  from_column_name: string
  to_column_name: string
}

export interface RelationshipView {
  id: number
  from_entity_id: number
  to_entity_id: number
  from_entity_name: string
  to_entity_name: string
  cardinality: string
  join_type_default: string
  is_curated: number
  column_pairs: RelationshipColumnPairView[]
}

function attachColumnPairs(relationships: Omit<RelationshipView, 'column_pairs'>[]): RelationshipView[] {
  const pairs = db
    .prepare(
      `SELECT p.relationship_id, p.from_column_id, p.to_column_id,
              fc.display_name AS from_column_name, tc.display_name AS to_column_name
       FROM relationship_column_pairs p
       JOIN entity_columns fc ON fc.id = p.from_column_id
       JOIN entity_columns tc ON tc.id = p.to_column_id
       ORDER BY p.relationship_id, p.seq`,
    )
    .all() as (RelationshipColumnPairView & { relationship_id: number })[]
  const pairsByRelationship = new Map<number, RelationshipColumnPairView[]>()
  for (const { relationship_id, ...pair } of pairs) {
    const list = pairsByRelationship.get(relationship_id)
    if (list) list.push(pair)
    else pairsByRelationship.set(relationship_id, [pair])
  }
  return relationships.map((rel) => ({
    ...rel,
    cardinality: enumValueFor(CARDINALITY_NAME, rel.cardinality)!,
    join_type_default: enumValueFor(JOIN_TYPE_NAME, rel.join_type_default)!,
    column_pairs: pairsByRelationship.get(rel.id) ?? [],
  }))
}

export function listRelationships(): RelationshipView[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.from_entity_id, r.to_entity_id, r.cardinality, r.join_type_default, r.is_curated,
              fe.display_name AS from_entity_name, te.display_name AS to_entity_name
       FROM relationships r
       JOIN entities fe ON fe.id = r.from_entity_id
       JOIN entities te ON te.id = r.to_entity_id
       ORDER BY r.id`,
    )
    .all() as Omit<RelationshipView, 'column_pairs'>[]
  return attachColumnPairs(rows)
}

function getRelationship(id: number): RelationshipView | undefined {
  const row = db
    .prepare(
      `SELECT r.id, r.from_entity_id, r.to_entity_id, r.cardinality, r.join_type_default, r.is_curated,
              fe.display_name AS from_entity_name, te.display_name AS to_entity_name
       FROM relationships r
       JOIN entities fe ON fe.id = r.from_entity_id
       JOIN entities te ON te.id = r.to_entity_id
       WHERE r.id = ?`,
    )
    .get(id) as Omit<RelationshipView, 'column_pairs'> | undefined
  return row ? attachColumnPairs([row])[0] : undefined
}

export interface RelationshipInput {
  from_entity_id: number
  to_entity_id: number
  cardinality: string
  join_type_default: string
  column_pairs: { from_column_id: number; to_column_id: number }[]
}

const insertRelationshipStmt = db.prepare(
  'INSERT INTO relationships (from_entity_id, to_entity_id, cardinality, join_type_default, is_curated) VALUES (?, ?, ?, ?, 1)',
)
const insertColumnPairStmt = db.prepare(
  'INSERT INTO relationship_column_pairs (relationship_id, from_column_id, to_column_id, seq) VALUES (?, ?, ?, ?)',
)
const deleteColumnPairsStmt = db.prepare('DELETE FROM relationship_column_pairs WHERE relationship_id = ?')

function insertColumnPairs(relationshipId: number, pairs: RelationshipInput['column_pairs']): void {
  pairs.forEach((pair, seq) => insertColumnPairStmt.run(relationshipId, pair.from_column_id, pair.to_column_id, seq))
}

// Plain wrapper functions, not a directly-exported `db.transaction(...)`
// result — `better-sqlite3`'s `Transaction<T>` type isn't nameable in this
// project's emitted `.d.ts` (tsc -b project references need one), so the
// transaction itself stays private and each export gets a normal,
// nameable function type.
const runCreateRelationship = db.transaction((input: RelationshipInput): RelationshipView => {
  const result = insertRelationshipStmt.run(
    input.from_entity_id,
    input.to_entity_id,
    enumNameFor(CARDINALITY_NAME, input.cardinality),
    enumNameFor(JOIN_TYPE_NAME, input.join_type_default),
  )
  const relationshipId = Number(result.lastInsertRowid)
  insertColumnPairs(relationshipId, input.column_pairs)
  return getRelationship(relationshipId)!
})

export function createRelationship(input: RelationshipInput): RelationshipView {
  return runCreateRelationship(input)
}

const runUpdateRelationship = db.transaction((id: number, input: RelationshipInput): RelationshipView | undefined => {
  if (!getRelationship(id)) return undefined
  db.prepare('UPDATE relationships SET from_entity_id = ?, to_entity_id = ?, cardinality = ?, join_type_default = ? WHERE id = ?').run(
    input.from_entity_id,
    input.to_entity_id,
    enumNameFor(CARDINALITY_NAME, input.cardinality),
    enumNameFor(JOIN_TYPE_NAME, input.join_type_default),
    id,
  )
  deleteColumnPairsStmt.run(id)
  insertColumnPairs(id, input.column_pairs)
  return getRelationship(id)
})

export function updateRelationship(id: number, input: RelationshipInput): RelationshipView | undefined {
  return runUpdateRelationship(id, input)
}

const runDeleteRelationship = db.transaction((id: number): boolean => {
  deleteColumnPairsStmt.run(id)
  return db.prepare('DELETE FROM relationships WHERE id = ?').run(id).changes > 0
})

export function deleteRelationship(id: number): boolean {
  return runDeleteRelationship(id)
}

// ---- Metrics (docs/data-studio-admin-ui-plan.md phase 4) — depends on
// entities/columns already synced (Data Sources). ----

export interface MetricRow {
  id: number
  name: string
  description: string | null
  synonyms: string
  base_entity_id: number
  base_entity_name: string
  aggregation: string
  measure_column_id: number
  measure_column_name: string
  default_filters: string
  time_column_id: number | null
  allowed_dimension_column_ids: string
  grain: string | null
  unit: string | null
  sample_nl_questions: string
  canonical_sql: string | null
  is_verified: number
}

const METRIC_SELECT = `
  SELECT m.*, be.display_name AS base_entity_name, mc.display_name AS measure_column_name
  FROM metrics m
  JOIN entities be ON be.id = m.base_entity_id
  JOIN entity_columns mc ON mc.id = m.measure_column_id
`

function denormalizeMetricRow(row: MetricRow): MetricRow {
  return { ...row, aggregation: enumValueFor(AGGREGATION_NAME, row.aggregation)! }
}

export function listMetrics(): MetricRow[] {
  return (db.prepare(`${METRIC_SELECT} ORDER BY m.name`).all() as MetricRow[]).map(denormalizeMetricRow)
}

export function getMetric(id: number): MetricRow | undefined {
  const row = db.prepare(`${METRIC_SELECT} WHERE m.id = ?`).get(id) as MetricRow | undefined
  return row && denormalizeMetricRow(row)
}

export interface MetricInput {
  name: string
  description?: string | null
  synonyms?: string[]
  base_entity_id: number
  aggregation: string
  measure_column_id: number
  default_filters?: string[]
  time_column_id?: number | null
  allowed_dimension_column_ids?: number[]
  grain?: string | null
  unit?: string | null
  sample_nl_questions?: string[]
  canonical_sql?: string | null
  is_verified?: boolean
}

export function createMetric(input: MetricInput): MetricRow {
  const result = db
    .prepare(
      `INSERT INTO metrics
       (name, description, synonyms, base_entity_id, aggregation, measure_column_id,
        default_filters, time_column_id, allowed_dimension_column_ids, grain, unit, sample_nl_questions, is_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      input.name,
      input.description ?? null,
      JSON.stringify(input.synonyms ?? []),
      input.base_entity_id,
      enumNameFor(AGGREGATION_NAME, input.aggregation),
      input.measure_column_id,
      JSON.stringify(input.default_filters ?? []),
      input.time_column_id ?? null,
      JSON.stringify(input.allowed_dimension_column_ids ?? []),
      input.grain ?? null,
      input.unit ?? null,
      JSON.stringify(input.sample_nl_questions ?? []),
    )
  return getMetric(Number(result.lastInsertRowid))!
}

const METRIC_UPDATABLE_FIELDS = [
  'name', 'description', 'synonyms', 'base_entity_id', 'aggregation', 'measure_column_id',
  'default_filters', 'time_column_id', 'allowed_dimension_column_ids', 'grain', 'unit', 'sample_nl_questions',
  'canonical_sql', 'is_verified',
] as const
const METRIC_JSON_ARRAY_FIELDS = new Set(['synonyms', 'default_filters', 'allowed_dimension_column_ids', 'sample_nl_questions'])

export function updateMetric(id: number, input: Partial<MetricInput>): MetricRow | undefined {
  const sets: string[] = []
  const values: unknown[] = []
  for (const field of METRIC_UPDATABLE_FIELDS) {
    if (!(field in input)) continue
    sets.push(`${field} = ?`)
    const value = input[field as keyof MetricInput]
    values.push(
      METRIC_JSON_ARRAY_FIELDS.has(field)
        ? JSON.stringify(value ?? [])
        : typeof value === 'boolean'
          ? (value ? 1 : 0)
          : field === 'aggregation' && typeof value === 'string'
            ? enumNameFor(AGGREGATION_NAME, value)
            : value,
    )
  }
  if (sets.length === 0) return getMetric(id)
  values.push(id)
  db.prepare(`UPDATE metrics SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getMetric(id)
}

export function deleteMetric(id: number): boolean {
  return db.prepare('DELETE FROM metrics WHERE id = ?').run(id).changes > 0
}

// ---- Dashboards (docs/data-studio-admin-ui-plan.md phase 5) — a saved
// collection of charts pinned from chat. `charts_chat`/`query_results_chat`/
// `messages_chat`/`conversations_chat` are written by
// packages/tool/data-studio-agent/python/bridge/runner.py's `_persist_chart`
// (Python), never by gateway — this file only ever READS from `charts_chat`
// to resolve a widget's chart data, same "gateway does plain CRUD, Python
// owns anything chat-shaped" split the rest of this file already follows. ----

export interface DashboardRow {
  id: number
  title: string
  description: string
  appearance_json: string
  created_at: string
  updated_at: string
}

export function listDashboards(): DashboardRow[] {
  return db.prepare('SELECT * FROM dashboards_chat ORDER BY updated_at DESC').all() as DashboardRow[]
}

export function getDashboard(id: number): DashboardRow | undefined {
  return db.prepare('SELECT * FROM dashboards_chat WHERE id = ?').get(id) as DashboardRow | undefined
}

export function createDashboard(title: string, description = ''): DashboardRow {
  const now = new Date().toISOString()
  const result = db
    .prepare('INSERT INTO dashboards_chat (title, description, appearance_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(title, description, '{}', now, now)
  return getDashboard(Number(result.lastInsertRowid))!
}

export function updateDashboard(id: number, input: { title?: string; description?: string }): DashboardRow | undefined {
  const sets: string[] = []
  const values: unknown[] = []
  if ('title' in input) {
    sets.push('title = ?')
    values.push(input.title)
  }
  if ('description' in input) {
    sets.push('description = ?')
    values.push(input.description)
  }
  if (sets.length === 0) return getDashboard(id)
  sets.push('updated_at = ?')
  values.push(new Date().toISOString())
  values.push(id)
  db.prepare(`UPDATE dashboards_chat SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getDashboard(id)
}

export function deleteDashboard(id: number): boolean {
  db.prepare('DELETE FROM dashboard_widgets_chat WHERE dashboard_id = ?').run(id)
  return db.prepare('DELETE FROM dashboards_chat WHERE id = ?').run(id).changes > 0
}

export interface DashboardWidgetView {
  id: number
  dashboard_id: number
  seq: number
  kind: string
  chart_id: number | null
  chart_type: string | null
  chart_title: string | null
  chart_x: string | null
  chart_y: string | null
  chart_rows: string | null
}

export function listWidgets(dashboardId: number): DashboardWidgetView[] {
  return db
    .prepare(
      `SELECT w.id, w.dashboard_id, w.seq, w.kind, w.chart_id,
              c.type AS chart_type, c.title AS chart_title, c.x AS chart_x, c.y_json AS chart_y, c.rows_json AS chart_rows
       FROM dashboard_widgets_chat w
       LEFT JOIN charts_chat c ON c.id = w.chart_id
       WHERE w.dashboard_id = ?
       ORDER BY w.seq`,
    )
    .all(dashboardId) as DashboardWidgetView[]
}

export function addChartWidget(dashboardId: number, chartId: number): DashboardWidgetView {
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM dashboard_widgets_chat WHERE dashboard_id = ?').get(dashboardId) as {
    maxSeq: number
  }
  const result = db
    .prepare('INSERT INTO dashboard_widgets_chat (dashboard_id, seq, kind, chart_id, x, y, w, h) VALUES (?, ?, ?, ?, 0, 0, 6, 4)')
    .run(dashboardId, maxSeq.maxSeq + 1, 'chart', chartId)
  return listWidgets(dashboardId).find((widget) => widget.id === Number(result.lastInsertRowid))!
}

export function removeWidget(dashboardId: number, widgetId: number): boolean {
  return db.prepare('DELETE FROM dashboard_widgets_chat WHERE id = ? AND dashboard_id = ?').run(widgetId, dashboardId).changes > 0
}

// Swaps this widget's `seq` with its immediate neighbor in the given
// direction — the simplest possible reorder (no drag/resize grid builder for
// this pass, see docs/data-studio-admin-ui-plan.md's own scope note).
export function moveWidget(dashboardId: number, widgetId: number, direction: 'up' | 'down'): boolean {
  const widgets = db
    .prepare('SELECT id, seq FROM dashboard_widgets_chat WHERE dashboard_id = ? ORDER BY seq')
    .all(dashboardId) as { id: number; seq: number }[]
  const index = widgets.findIndex((w) => w.id === widgetId)
  const neighborIndex = direction === 'up' ? index - 1 : index + 1
  if (index === -1 || neighborIndex < 0 || neighborIndex >= widgets.length) return false
  const current = widgets[index]
  const neighbor = widgets[neighborIndex]
  const swap = db.transaction(() => {
    db.prepare('UPDATE dashboard_widgets_chat SET seq = ? WHERE id = ?').run(neighbor.seq, current.id)
    db.prepare('UPDATE dashboard_widgets_chat SET seq = ? WHERE id = ?').run(current.seq, neighbor.id)
  })
  swap()
  return true
}
