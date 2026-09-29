// Semantic-layer admin CRUD (docs/data-studio-admin-ui-plan.md) on MongoDB
// (docs/data-studio-mongodb-plan.md). Reads and writes the SAME database the Python pipeline
// (packages/tool/data-studio-agent/python — src/crud_mongo/*) reads at query time and that
// bot-data-studio-api uses, so document shapes here must stay identical to crud_mongo's:
//   * `_id` is a uuid4 string; the wire field `id` is that string (was an autoincrement int).
//   * enums are stored as their VALUES ("count", "1:N", "connected") — the old sqlite layer stored
//     SQLAlchemy member NAMES and needed a name<->value map; that whole class of bug is gone.
//   * arrays / booleans are stored natively.
// Wire compatibility: the JSON this file returns keeps the shape the FE already consumes —
// booleans as 0/1 and array fields as JSON strings. Only ids changed (number -> string). This is a
// deliberate edge adapter; drop `wire*` helpers together with the FE's JSON.parse calls later.
//
// No cross-collection transactions (same decision as the Python side): cascades delete children
// first, then the parent, sequentially and best-effort.

import { randomUUID } from 'node:crypto'

import { col, type Doc } from './mongo.ts'

const now = (): Date => new Date()
const flag = (value: unknown): 0 | 1 => (value ? 1 : 0)
const json = (value: unknown): string => JSON.stringify(value ?? [])
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : ((value as string | null | undefined) ?? null))

// ---- Data sources ----

export interface DataSourceRow {
  id: string
  name: string
  source_type: string
  dremio_path: string
  status: string
  last_synced_at: string | null
  is_exposed_to_agent: 0 | 1
}

function toDataSourceRow(d: Doc): DataSourceRow {
  return {
    id: d._id,
    name: d.name,
    source_type: d.source_type,
    dremio_path: d.dremio_path,
    status: d.status,
    last_synced_at: iso(d.last_synced_at),
    is_exposed_to_agent: flag(d.is_exposed_to_agent),
  }
}

export async function listDataSources(): Promise<DataSourceRow[]> {
  return (await col('data_sources').find().sort({ name: 1 }).toArray()).map(toDataSourceRow)
}

export async function getDataSource(id: string): Promise<DataSourceRow | undefined> {
  const doc = await col('data_sources').findOne({ _id: id })
  return doc ? toDataSourceRow(doc) : undefined
}

export async function updateDataSource(id: string, input: { is_exposed_to_agent?: boolean }): Promise<DataSourceRow | undefined> {
  if ('is_exposed_to_agent' in input) {
    await col('data_sources').updateOne({ _id: id }, { $set: { is_exposed_to_agent: !!input.is_exposed_to_agent, updated_at: now() } })
  }
  return getDataSource(id)
}

// ---- Entities ----

export interface EntityRow {
  id: string
  data_source_id: string
  physical_path: string
  physical_name: string
  entity_type: string
  is_deprecated: 0 | 1
  display_name: string
  description: string | null
  synonyms: string
  grain_description: string | null
  is_exposed: 0 | 1
  is_pii: 0 | 1
  row_count_est: number | null
}

function toEntityRow(d: Doc): EntityRow {
  return {
    id: d._id,
    data_source_id: d.data_source_id,
    physical_path: d.physical_path,
    physical_name: d.physical_name,
    entity_type: d.entity_type,
    is_deprecated: flag(d.is_deprecated),
    display_name: d.display_name,
    description: d.description ?? null,
    synonyms: json(d.synonyms),
    grain_description: d.grain_description ?? null,
    is_exposed: flag(d.is_exposed),
    is_pii: flag(d.is_pii),
    row_count_est: d.row_count_est ?? null,
  }
}

export async function listEntitiesForSource(dataSourceId: string): Promise<EntityRow[]> {
  return (await col('entities').find({ data_source_id: dataSourceId }).sort({ physical_name: 1 }).toArray()).map(toEntityRow)
}

export async function getEntity(id: string): Promise<EntityRow | undefined> {
  const doc = await col('entities').findOne({ _id: id })
  return doc ? toEntityRow(doc) : undefined
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

// Copies only whitelisted fields present on `input` (and coerces the shapes Mongo stores natively).
function pickFields(input: object, allowed: readonly string[], arrayFields: ReadonlySet<string>, boolFields: ReadonlySet<string>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const field of allowed) {
    if (!(field in input)) continue
    const value = (input as Record<string, unknown>)[field]
    fields[field] = arrayFields.has(field) ? (Array.isArray(value) ? value : []) : boolFields.has(field) ? !!value : value
  }
  return fields
}

export async function updateEntity(id: string, input: EntityUpdateInput): Promise<EntityRow | undefined> {
  const fields = pickFields(input, ENTITY_UPDATABLE_FIELDS, new Set(['synonyms']), new Set(['is_exposed', 'is_pii']))
  if (Object.keys(fields).length > 0) await col('entities').updateOne({ _id: id }, { $set: { ...fields, updated_at: now() } })
  return getEntity(id)
}

// ---- Entity columns ----

export interface EntityColumnRow {
  id: string
  entity_id: string
  physical_name: string
  data_type: string
  ordinal: number
  is_nullable: 0 | 1
  is_deprecated: 0 | 1
  display_name: string
  description: string | null
  synonyms: string
  role: string | null
  semantic_type: string | null
  default_aggregation: string | null
  value_glossary: string
  is_exposed: 0 | 1
  is_pii: 0 | 1
  is_default_select: 0 | 1
  distinct_count: number | null
  sample_values: string
  min_val: string | null
  max_val: string | null
  null_ratio: number | null
}

function toColumnRow(d: Doc): EntityColumnRow {
  return {
    id: d._id,
    entity_id: d.entity_id,
    physical_name: d.physical_name,
    data_type: d.data_type,
    ordinal: d.ordinal,
    is_nullable: flag(d.is_nullable ?? true),
    is_deprecated: flag(d.is_deprecated),
    display_name: d.display_name,
    description: d.description ?? null,
    synonyms: json(d.synonyms),
    role: d.role ?? null,
    semantic_type: d.semantic_type ?? null,
    default_aggregation: d.default_aggregation ?? null,
    value_glossary: JSON.stringify(d.value_glossary ?? {}),
    is_exposed: flag(d.is_exposed),
    is_pii: flag(d.is_pii),
    is_default_select: flag(d.is_default_select),
    distinct_count: d.distinct_count ?? null,
    sample_values: json(d.sample_values),
    min_val: d.min_val ?? null,
    max_val: d.max_val ?? null,
    null_ratio: d.null_ratio ?? null,
  }
}

export async function listColumnsForEntity(entityId: string): Promise<EntityColumnRow[]> {
  return (await col('entity_columns').find({ entity_id: entityId }).sort({ ordinal: 1 }).toArray()).map(toColumnRow)
}

export async function getEntityColumn(id: string): Promise<EntityColumnRow | undefined> {
  const doc = await col('entity_columns').findOne({ _id: id })
  return doc ? toColumnRow(doc) : undefined
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

export async function updateEntityColumn(id: string, input: EntityColumnUpdateInput): Promise<EntityColumnRow | undefined> {
  const fields = pickFields(input, COLUMN_UPDATABLE_FIELDS, new Set(['synonyms']), new Set(['is_exposed', 'is_pii', 'is_default_select']))
  // The FE sends '' for "no value" on the 3 enum selects; Mongo stores null, and the Python side
  // filters on `role: {$nin: ["key", None]}`, so an empty string would be a real (wrong) value.
  for (const field of ['role', 'semantic_type', 'default_aggregation'] as const) {
    if (fields[field] === '') fields[field] = null
  }
  if (Object.keys(fields).length > 0) await col('entity_columns').updateOne({ _id: id }, { $set: { ...fields, updated_at: now() } })
  return getEntityColumn(id)
}

// ---- Glossary ----

export interface GlossaryTermRow {
  id: string
  term: string
  synonyms: string
  definition_text: string
  sql_expressions: string
  related_entity_ids: string
}

function toGlossaryRow(d: Doc): GlossaryTermRow {
  return {
    id: d._id,
    term: d.term,
    synonyms: json(d.synonyms),
    definition_text: d.definition_text,
    sql_expressions: json(d.sql_expressions),
    related_entity_ids: json(d.related_entity_ids),
  }
}

export async function listGlossaryTerms(): Promise<GlossaryTermRow[]> {
  return (await col('business_glossary').find().sort({ term: 1 }).toArray()).map(toGlossaryRow)
}

export async function getGlossaryTerm(id: string): Promise<GlossaryTermRow | undefined> {
  const doc = await col('business_glossary').findOne({ _id: id })
  return doc ? toGlossaryRow(doc) : undefined
}

export interface GlossaryTermInput {
  term: string
  synonyms?: string[]
  definition_text: string
  sql_expressions?: string[]
  related_entity_ids?: string[]
}

export async function createGlossaryTerm(input: GlossaryTermInput): Promise<GlossaryTermRow> {
  const at = now()
  const doc: Doc = {
    _id: randomUUID(),
    term: input.term,
    synonyms: input.synonyms ?? [],
    definition_text: input.definition_text,
    sql_expressions: input.sql_expressions ?? [],
    related_entity_ids: input.related_entity_ids ?? [],
    created_at: at,
    updated_at: at,
  }
  await col('business_glossary').insertOne(doc)
  return toGlossaryRow(doc)
}

const GLOSSARY_UPDATABLE_FIELDS = ['term', 'synonyms', 'definition_text', 'sql_expressions', 'related_entity_ids'] as const
const GLOSSARY_ARRAY_FIELDS = new Set(['synonyms', 'sql_expressions', 'related_entity_ids'])

export async function updateGlossaryTerm(id: string, input: Partial<GlossaryTermInput>): Promise<GlossaryTermRow | undefined> {
  const fields = pickFields(input, GLOSSARY_UPDATABLE_FIELDS, GLOSSARY_ARRAY_FIELDS, new Set())
  if (Object.keys(fields).length > 0) await col('business_glossary').updateOne({ _id: id }, { $set: { ...fields, updated_at: now() } })
  return getGlossaryTerm(id)
}

export async function deleteGlossaryTerm(id: string): Promise<boolean> {
  return (await col('business_glossary').deleteOne({ _id: id })).deletedCount > 0
}

// ---- Browse (relationship-builder pickers) ----

export interface BrowseEntity {
  id: string
  display_name: string
  physical_name: string
  data_source_id: string
  columns: { id: string; display_name: string; physical_name: string }[]
}

// Every entity across every data source with its columns nested. Small tables in practice (one
// semantic layer), so two scans + an in-memory group is simpler than an aggregation.
export async function listBrowseEntities(): Promise<BrowseEntity[]> {
  const [entities, columns] = await Promise.all([
    col('entities').find().sort({ display_name: 1 }).toArray(),
    col('entity_columns').find().sort({ ordinal: 1 }).toArray(),
  ])
  const columnsByEntity = new Map<string, BrowseEntity['columns']>()
  for (const c of columns) {
    const entry = { id: c._id, display_name: c.display_name, physical_name: c.physical_name }
    const list = columnsByEntity.get(c.entity_id)
    if (list) list.push(entry)
    else columnsByEntity.set(c.entity_id, [entry])
  }
  return entities.map((e) => ({
    id: e._id,
    display_name: e.display_name,
    physical_name: e.physical_name,
    data_source_id: e.data_source_id,
    columns: columnsByEntity.get(e._id) ?? [],
  }))
}

// ---- Relationships ----

export interface RelationshipColumnPairView {
  from_column_id: string
  to_column_id: string
  from_column_name: string
  to_column_name: string
}

export interface RelationshipView {
  id: string
  from_entity_id: string
  to_entity_id: string
  from_entity_name: string
  to_entity_name: string
  cardinality: string
  join_type_default: string
  is_curated: 0 | 1
  column_pairs: RelationshipColumnPairView[]
}

async function toRelationshipViews(relationships: Doc[]): Promise<RelationshipView[]> {
  if (relationships.length === 0) return []
  const relationshipIds = relationships.map((r) => r._id)
  const pairs = await col('relationship_column_pairs').find({ relationship_id: { $in: relationshipIds } }).sort({ seq: 1 }).toArray()
  const entityIds = [...new Set(relationships.flatMap((r) => [r.from_entity_id, r.to_entity_id]))]
  const columnIds = [...new Set(pairs.flatMap((p) => [p.from_column_id, p.to_column_id]))]
  const [entities, columns] = await Promise.all([
    col('entities').find({ _id: { $in: entityIds } }).toArray(),
    col('entity_columns').find({ _id: { $in: columnIds } }).toArray(),
  ])
  const entityName = new Map(entities.map((e) => [e._id, e.display_name as string]))
  const columnName = new Map(columns.map((c) => [c._id, c.display_name as string]))
  const pairsByRelationship = new Map<string, RelationshipColumnPairView[]>()
  for (const p of pairs) {
    const view: RelationshipColumnPairView = {
      from_column_id: p.from_column_id,
      to_column_id: p.to_column_id,
      from_column_name: columnName.get(p.from_column_id) ?? '?',
      to_column_name: columnName.get(p.to_column_id) ?? '?',
    }
    const list = pairsByRelationship.get(p.relationship_id)
    if (list) list.push(view)
    else pairsByRelationship.set(p.relationship_id, [view])
  }
  return relationships.map((r) => ({
    id: r._id,
    from_entity_id: r.from_entity_id,
    to_entity_id: r.to_entity_id,
    from_entity_name: entityName.get(r.from_entity_id) ?? '?',
    to_entity_name: entityName.get(r.to_entity_id) ?? '?',
    cardinality: r.cardinality,
    join_type_default: r.join_type_default,
    is_curated: flag(r.is_curated),
    column_pairs: pairsByRelationship.get(r._id) ?? [],
  }))
}

export async function listRelationships(): Promise<RelationshipView[]> {
  return toRelationshipViews(await col('relationships').find().sort({ created_at: 1 }).toArray())
}

async function getRelationship(id: string): Promise<RelationshipView | undefined> {
  const doc = await col('relationships').findOne({ _id: id })
  return doc ? (await toRelationshipViews([doc]))[0] : undefined
}

export interface RelationshipInput {
  from_entity_id: string
  to_entity_id: string
  cardinality: string
  join_type_default: string
  column_pairs: { from_column_id: string; to_column_id: string }[]
}

async function insertColumnPairs(relationshipId: string, pairs: RelationshipInput['column_pairs']): Promise<void> {
  if (pairs.length === 0) return // insertMany rejects an empty batch (the route requires >= 1 pair anyway)
  const at = now()
  await col('relationship_column_pairs').insertMany(
    pairs.map((pair, seq) => ({
      _id: randomUUID(),
      relationship_id: relationshipId,
      from_column_id: pair.from_column_id,
      to_column_id: pair.to_column_id,
      seq,
      created_at: at,
      updated_at: at,
    })),
  )
}

export async function createRelationship(input: RelationshipInput): Promise<RelationshipView> {
  const at = now()
  const doc: Doc = {
    _id: randomUUID(),
    from_entity_id: input.from_entity_id,
    to_entity_id: input.to_entity_id,
    cardinality: input.cardinality,
    join_type_default: input.join_type_default,
    is_curated: true,
    created_at: at,
    updated_at: at,
  }
  await col('relationships').insertOne(doc)
  await insertColumnPairs(doc._id, input.column_pairs)
  return (await getRelationship(doc._id))!
}

export async function updateRelationship(id: string, input: RelationshipInput): Promise<RelationshipView | undefined> {
  if (!(await col('relationships').findOne({ _id: id }, { projection: { _id: 1 } }))) return undefined
  await col('relationships').updateOne(
    { _id: id },
    {
      $set: {
        from_entity_id: input.from_entity_id,
        to_entity_id: input.to_entity_id,
        cardinality: input.cardinality,
        join_type_default: input.join_type_default,
        updated_at: now(),
      },
    },
  )
  await col('relationship_column_pairs').deleteMany({ relationship_id: id })
  await insertColumnPairs(id, input.column_pairs)
  return getRelationship(id)
}

export async function deleteRelationship(id: string): Promise<boolean> {
  await col('relationship_column_pairs').deleteMany({ relationship_id: id })
  return (await col('relationships').deleteOne({ _id: id })).deletedCount > 0
}

// ---- Metrics ----

export interface MetricRow {
  id: string
  name: string
  description: string | null
  synonyms: string
  base_entity_id: string
  base_entity_name: string
  aggregation: string
  measure_column_id: string
  measure_column_name: string
  default_filters: string
  time_column_id: string | null
  allowed_dimension_column_ids: string
  grain: string | null
  unit: string | null
  sample_nl_questions: string
  canonical_sql: string | null
  is_verified: 0 | 1
}

async function toMetricRows(metrics: Doc[]): Promise<MetricRow[]> {
  if (metrics.length === 0) return []
  const entityIds = [...new Set(metrics.map((m) => m.base_entity_id))]
  const columnIds = [...new Set(metrics.map((m) => m.measure_column_id))]
  const [entities, columns] = await Promise.all([
    col('entities').find({ _id: { $in: entityIds } }).toArray(),
    col('entity_columns').find({ _id: { $in: columnIds } }).toArray(),
  ])
  const entityName = new Map(entities.map((e) => [e._id, e.display_name as string]))
  const columnName = new Map(columns.map((c) => [c._id, c.display_name as string]))
  return metrics.map((m) => ({
    id: m._id,
    name: m.name,
    description: m.description ?? null,
    synonyms: json(m.synonyms),
    base_entity_id: m.base_entity_id,
    base_entity_name: entityName.get(m.base_entity_id) ?? '?',
    aggregation: m.aggregation,
    measure_column_id: m.measure_column_id,
    measure_column_name: columnName.get(m.measure_column_id) ?? '?',
    default_filters: json(m.default_filters),
    time_column_id: m.time_column_id ?? null,
    allowed_dimension_column_ids: json(m.allowed_dimension_column_ids),
    grain: m.grain ?? null,
    unit: m.unit ?? null,
    sample_nl_questions: json(m.sample_nl_questions),
    canonical_sql: m.canonical_sql ?? null,
    is_verified: flag(m.is_verified),
  }))
}

export async function listMetrics(): Promise<MetricRow[]> {
  return toMetricRows(await col('metrics').find().sort({ name: 1 }).toArray())
}

export async function getMetric(id: string): Promise<MetricRow | undefined> {
  const doc = await col('metrics').findOne({ _id: id })
  return doc ? (await toMetricRows([doc]))[0] : undefined
}

export interface MetricInput {
  name: string
  description?: string | null
  synonyms?: string[]
  base_entity_id: string
  aggregation: string
  measure_column_id: string
  default_filters?: string[]
  time_column_id?: string | null
  allowed_dimension_column_ids?: string[]
  grain?: string | null
  unit?: string | null
  sample_nl_questions?: string[]
  canonical_sql?: string | null
  is_verified?: boolean
}

export async function createMetric(input: MetricInput): Promise<MetricRow> {
  const at = now()
  // Same field set the Python metric route persists (MetricRequest.model_dump()).
  const doc: Doc = {
    _id: randomUUID(),
    name: input.name,
    description: input.description ?? null,
    synonyms: input.synonyms ?? [],
    base_entity_id: input.base_entity_id,
    aggregation: input.aggregation,
    measure_column_id: input.measure_column_id,
    default_filters: input.default_filters ?? [],
    time_column_id: input.time_column_id ?? null,
    allowed_dimension_column_ids: input.allowed_dimension_column_ids ?? [],
    grain: input.grain ?? null,
    unit: input.unit ?? null,
    sample_nl_questions: input.sample_nl_questions ?? [],
    canonical_sql: input.canonical_sql ?? null,
    is_verified: false,
    created_at: at,
    updated_at: at,
  }
  await col('metrics').insertOne(doc)
  return (await getMetric(doc._id))!
}

const METRIC_UPDATABLE_FIELDS = [
  'name', 'description', 'synonyms', 'base_entity_id', 'aggregation', 'measure_column_id',
  'default_filters', 'time_column_id', 'allowed_dimension_column_ids', 'grain', 'unit', 'sample_nl_questions',
  'canonical_sql', 'is_verified',
] as const
const METRIC_ARRAY_FIELDS = new Set(['synonyms', 'default_filters', 'allowed_dimension_column_ids', 'sample_nl_questions'])

export async function updateMetric(id: string, input: Partial<MetricInput>): Promise<MetricRow | undefined> {
  const fields = pickFields(input, METRIC_UPDATABLE_FIELDS, METRIC_ARRAY_FIELDS, new Set(['is_verified']))
  if (Object.keys(fields).length > 0) await col('metrics').updateOne({ _id: id }, { $set: { ...fields, updated_at: now() } })
  return getMetric(id)
}

export async function deleteMetric(id: string): Promise<boolean> {
  return (await col('metrics').deleteOne({ _id: id })).deletedCount > 0
}

// ---- Charts + dashboards (clone of the reference UI's flows: edit fields / colors, add to dashboard,
// dashboard list / report / builder) ----
// `conversations`/`messages`/`query_results`/`charts` are WRITTEN by the Python worker (bridge/runner.py's
// chart persistence); gateway reads them and persists the user's chart edits (overrides) and pin state.
// Unlike the admin tables above, these endpoints return the reference API's native shapes (real arrays,
// booleans and objects — see bot-data-studio-api's routes/dashboard.py) because the dashboard UI is a new
// clone of that reference, not the old wire-compat FE.

export interface ChartOut {
  id: string
  type: string
  title: string
  description: string
  x: string | null
  y: string[]
  value_field: string | null
  recommended: boolean
  is_pinned: boolean
  title_override: string | null
  x_override: string | null
  y_override: string[] | null
  color_overrides: Record<string, string>
  label_overrides: Record<string, string>
  rows: Record<string, unknown>[]
}

// A chart carries its own (possibly transformed) rows; charts saved before that existed fall back to the
// shared SQL result of their query.
async function toChartOuts(charts: Doc[]): Promise<ChartOut[]> {
  const missing = [...new Set(charts.filter((c) => !c.rows_json || c.rows_json.length === 0).map((c) => c.query_result_id))]
  const results = missing.length > 0 ? await col('query_results').find({ _id: { $in: missing } }).toArray() : []
  const sharedRows = new Map(results.map((r) => [r._id, (r.rows_json ?? []) as Record<string, unknown>[]]))
  return charts.map((c) => ({
    id: c._id,
    type: c.type,
    title: c.title ?? '',
    description: c.description ?? '',
    x: c.x ?? null,
    y: c.y_json ?? [],
    value_field: c.value_field ?? null,
    recommended: !!c.recommended,
    is_pinned: !!c.is_pinned,
    title_override: c.title_override ?? null,
    x_override: c.x_override ?? null,
    y_override: c.y_override_json ?? null,
    color_overrides: c.color_overrides_json ?? {},
    label_overrides: c.label_overrides_json ?? {},
    rows: c.rows_json && c.rows_json.length > 0 ? c.rows_json : (sharedRows.get(c.query_result_id) ?? []),
  }))
}

export async function getChart(id: string): Promise<ChartOut | undefined> {
  const doc = await col('charts').findOne({ _id: id })
  return doc ? (await toChartOuts([doc]))[0] : undefined
}

export interface ChartUpdateInput {
  title_override?: string | null
  x_override?: string | null
  y_override?: string[] | null
  color_overrides?: Record<string, string> | null
  label_overrides?: Record<string, string> | null
}

// Persists the toolbar edits so they survive a reload. Omitted fields stay unchanged; an explicit empty value
// ('' / [] / {}) clears an override and falls back to the recommended field(s) — same rules as the reference API.
export async function updateChart(id: string, input: ChartUpdateInput): Promise<ChartOut | undefined> {
  const fields: Record<string, unknown> = {}
  if ('title_override' in input) fields.title_override = input.title_override || null
  if ('x_override' in input) fields.x_override = input.x_override || null
  if ('y_override' in input) fields.y_override_json = input.y_override && input.y_override.length > 0 ? input.y_override : null
  if ('color_overrides' in input) fields.color_overrides_json = input.color_overrides ?? {}
  if ('label_overrides' in input) fields.label_overrides_json = input.label_overrides ?? {}
  if (Object.keys(fields).length > 0) await col('charts').updateOne({ _id: id }, { $set: { ...fields, updated_at: now() } })
  return getChart(id)
}

export interface DashboardSummary {
  id: string
  title: string
  description: string
  widget_count: number
  updated_at: string
}

export interface WidgetOut {
  id: string
  seq: number
  kind: string
  x: number
  y: number
  w: number
  h: number
  title_override: string | null
  note: string | null
  text: string | null
  config: Record<string, unknown>
  chart: ChartOut | null
}

export interface DashboardDetail {
  id: string
  title: string
  description: string
  appearance: Record<string, unknown>
  widgets: WidgetOut[]
}

export async function listDashboards(): Promise<DashboardSummary[]> {
  const dashboards = await col('dashboards').find().sort({ updated_at: -1 }).toArray()
  if (dashboards.length === 0) return []
  const widgets = await col('dashboard_widgets')
    .find({ dashboard_id: { $in: dashboards.map((d) => d._id) }, kind: 'chart', chart_id: { $ne: null } })
    .toArray()
  const chartIds = [...new Set(widgets.map((w) => w.chart_id as string))]
  const live = new Set((await col('charts').find({ _id: { $in: chartIds } }, { projection: { _id: 1 } }).toArray()).map((c) => c._id))
  const counts = new Map<string, number>()
  for (const w of widgets) if (live.has(w.chart_id)) counts.set(w.dashboard_id, (counts.get(w.dashboard_id) ?? 0) + 1)
  return dashboards.map((d) => ({
    id: d._id,
    title: d.title,
    description: d.description ?? '',
    widget_count: counts.get(d._id) ?? 0,
    updated_at: iso(d.updated_at) ?? '',
  }))
}

async function toDashboardDetail(d: Doc): Promise<DashboardDetail> {
  const widgets = await col('dashboard_widgets').find({ dashboard_id: d._id }).sort({ seq: 1 }).toArray()
  const chartIds = [...new Set(widgets.filter((w) => w.kind === 'chart' && w.chart_id).map((w) => w.chart_id as string))]
  const charts = chartIds.length > 0 ? await toChartOuts(await col('charts').find({ _id: { $in: chartIds } }).toArray()) : []
  const chartById = new Map(charts.map((c) => [c.id, c]))
  const out: WidgetOut[] = []
  for (const w of widgets) {
    const chart = w.kind === 'chart' ? (chartById.get(w.chart_id) ?? null) : null
    if (w.kind === 'chart' && !chart) continue // its source chart was deleted
    out.push({
      id: w._id, seq: w.seq, kind: w.kind, x: w.x, y: w.y, w: w.w, h: w.h,
      title_override: w.title_override ?? null, note: w.note ?? null, text: w.text ?? null,
      config: w.config_json ?? {}, chart,
    })
  }
  return { id: d._id, title: d.title, description: d.description ?? '', appearance: d.appearance_json ?? {}, widgets: out }
}

export async function getDashboard(id: string): Promise<DashboardDetail | undefined> {
  const doc = await col('dashboards').findOne({ _id: id })
  return doc ? toDashboardDetail(doc) : undefined
}

export async function createDashboard(title?: string, description?: string): Promise<DashboardDetail> {
  const at = now()
  const doc: Doc = {
    _id: randomUUID(), title: title?.trim() || 'Dashboard chưa đặt tên', description: description ?? '',
    appearance_json: {}, created_at: at, updated_at: at,
  }
  await col('dashboards').insertOne(doc)
  return toDashboardDetail(doc)
}

export async function updateDashboard(
  id: string,
  input: { title?: string | null; description?: string | null; appearance?: Record<string, unknown> | null },
): Promise<DashboardDetail | undefined> {
  const fields: Record<string, unknown> = {}
  if (input.title != null) fields.title = input.title
  if (input.description != null) fields.description = input.description
  if (input.appearance != null) fields.appearance_json = input.appearance
  const res = await col('dashboards').findOneAndUpdate({ _id: id }, { $set: { ...fields, updated_at: now() } }, { returnDocument: 'after' })
  return res ? toDashboardDetail(res) : undefined
}

export async function deleteDashboard(id: string): Promise<boolean> {
  await col('dashboard_widgets').deleteMany({ dashboard_id: id })
  return (await col('dashboards').deleteOne({ _id: id })).deletedCount > 0
}

async function touchDashboard(id: string): Promise<Doc | null> {
  return col('dashboards').findOneAndUpdate({ _id: id }, { $set: { updated_at: now() } }, { returnDocument: 'after' })
}

function newWidget(dashboardId: string, seq: number, fields: Partial<Doc>): Doc {
  const at = now()
  return {
    _id: randomUUID(), dashboard_id: dashboardId, seq, kind: 'chart', chart_id: null,
    x: 0, y: 0, w: 6, h: 4, title_override: null, note: null, text: null, config_json: {},
    created_at: at, updated_at: at, ...fields,
  }
}

// "Thêm vào dashboard" from a chat chart: two per row on the 12-column grid, stacking downward.
export async function pinChart(dashboardId: string, chartId: string): Promise<DashboardDetail | 'no-dashboard' | 'no-chart'> {
  if (!(await col('dashboards').findOne({ _id: dashboardId }, { projection: { _id: 1 } }))) return 'no-dashboard'
  if (!(await col('charts').findOne({ _id: chartId }, { projection: { _id: 1 } }))) return 'no-chart'
  const seq = await col('dashboard_widgets').countDocuments({ dashboard_id: dashboardId })
  await col('dashboard_widgets').insertOne(newWidget(dashboardId, seq, { chart_id: chartId, x: seq % 2 ? 6 : 0, y: Math.floor(seq / 2) * 4 }))
  await col('charts').updateOne({ _id: chartId }, { $set: { is_pinned: true, updated_at: now() } })
  return toDashboardDetail((await touchDashboard(dashboardId))!)
}

export interface AvailableChart {
  chart_id: string
  type: string
  title: string
  conversation_title: string | null
  chart: ChartOut
}

// The builder's "từ hội thoại" list: every saved chart, newest first, labelled with its conversation.
export async function availableCharts(): Promise<AvailableChart[]> {
  const charts = await col('charts').find().sort({ created_at: -1 }).limit(300).toArray()
  if (charts.length === 0) return []
  const outs = await toChartOuts(charts)
  const results = await col('query_results').find({ _id: { $in: [...new Set(charts.map((c) => c.query_result_id))] } }, { projection: { message_id: 1 } }).toArray()
  const messages = await col('messages').find({ _id: { $in: [...new Set(results.map((r) => r.message_id))] } }, { projection: { conversation_id: 1 } }).toArray()
  const conversations = await col('conversations').find({ _id: { $in: [...new Set(messages.map((m) => m.conversation_id))] } }, { projection: { title: 1 } }).toArray()
  const messageConv = new Map(messages.map((m) => [m._id, m.conversation_id]))
  const resultMessage = new Map(results.map((r) => [r._id, r.message_id]))
  const convTitle = new Map(conversations.map((c) => [c._id, (c.title ?? null) as string | null]))
  return charts.map((c, i) => ({
    chart_id: c._id,
    type: c.type,
    title: c.title_override || c.title || '',
    conversation_title: convTitle.get(messageConv.get(resultMessage.get(c.query_result_id) ?? '') ?? '') ?? null,
    chart: outs[i],
  }))
}

export async function addWidget(
  dashboardId: string,
  input: { kind?: string; chart_id?: string | null; text?: string | null; title?: string | null },
): Promise<DashboardDetail | 'no-dashboard' | 'no-chart'> {
  if (!(await col('dashboards').findOne({ _id: dashboardId }, { projection: { _id: 1 } }))) return 'no-dashboard'
  const kind = input.kind ?? 'text'
  if (kind === 'chart' && (!input.chart_id || !(await col('charts').findOne({ _id: input.chart_id }, { projection: { _id: 1 } })))) return 'no-chart'
  const existing = await col('dashboard_widgets').find({ dashboard_id: dashboardId }, { projection: { y: 1, h: 1 } }).toArray()
  const bottom = Math.max(0, ...existing.map((w) => w.y + w.h))
  await col('dashboard_widgets').insertOne(
    newWidget(dashboardId, existing.length, {
      kind, chart_id: kind === 'chart' ? input.chart_id : null, text: input.text ?? null, title_override: input.title ?? null,
      x: 0, y: bottom, w: kind === 'text' ? 12 : 6, h: kind === 'text' ? 2 : 4,
    }),
  )
  return toDashboardDetail((await touchDashboard(dashboardId))!)
}

export interface WidgetLayoutInput {
  id?: string | null
  kind?: string
  chart_id?: string | null
  x?: number
  y?: number
  w?: number
  h?: number
  title_override?: string | null
  note?: string | null
  text?: string | null
}

// Bulk-save from the builder ("Xuất bản"): widgets with a known id are updated in list order, the rest are created,
// and every existing widget missing from the list is deleted. Sequential writes, no transaction (see the header).
export async function saveWidgets(dashboardId: string, widgets: WidgetLayoutInput[]): Promise<DashboardDetail | undefined> {
  if (!(await col('dashboards').findOne({ _id: dashboardId }, { projection: { _id: 1 } }))) return undefined
  const existing = new Set((await col('dashboard_widgets').find({ dashboard_id: dashboardId }, { projection: { _id: 1 } }).toArray()).map((w) => w._id))
  const kept = new Set<string>()
  for (const [seq, w] of widgets.entries()) {
    const layout = { x: w.x ?? 0, y: w.y ?? 0, w: w.w ?? 6, h: w.h ?? 4 }
    if (w.id && existing.has(w.id)) {
      await col('dashboard_widgets').updateOne(
        { _id: w.id },
        { $set: { seq, ...layout, title_override: w.title_override ?? null, note: w.note ?? null, text: w.text ?? null, updated_at: now() } },
      )
      kept.add(w.id)
    } else {
      const kind = w.kind ?? 'chart'
      await col('dashboard_widgets').insertOne(
        newWidget(dashboardId, seq, {
          kind, chart_id: kind === 'chart' ? (w.chart_id ?? null) : null, ...layout,
          title_override: w.title_override ?? null, note: w.note ?? null, text: w.text ?? null,
        }),
      )
    }
  }
  const stale = [...existing].filter((id) => !kept.has(id))
  if (stale.length > 0) await col('dashboard_widgets').deleteMany({ _id: { $in: stale } })
  return toDashboardDetail((await touchDashboard(dashboardId))!)
}
