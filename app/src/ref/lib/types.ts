// Copied from bot-data-studio-web-main/src/lib/types.ts by scripts/sync-ref-profile.mjs — edit there, not here.
export type DataSourceStatus = "connected" | "error" | "disconnected";

export type ColumnRole = "dimension" | "measure" | "key";

export type SemanticType =
  | "currency"
  | "date"
  | "datetime"
  | "category"
  | "id"
  | "percent"
  | "count"
  | "number"
  | "text"
  | "pii"
  | "boolean";

export type DefaultAggregation = "sum" | "avg" | "count" | "count_distinct" | "min" | "max";

export type Cardinality = "1:1" | "1:N" | "N:N";

export type JoinType = "inner" | "left";

export interface AvailableDremioSource {
  name: string;
  type: string;
}

export interface DremioDataset {
  path: string[];
  schema_name: string;
  name: string;
  type: string;
  imported: boolean;
}

export interface DataSource {
  id: string;
  name: string;
  source_type: string;
  status: DataSourceStatus;
  last_synced_at: string | null;
  entity_count: number;
  disabled: boolean; // hidden from the agents (its tables, metrics and terms with it)
}

export interface Entity {
  id: string;
  physical_name: string;
  display_name: string;
  entity_type: "table" | "view" | "vds";
  description: string | null;
  synonyms: string[];
  grain_description: string | null;
  row_count_est: number | null;
  last_profiled_at: string | null;
  is_exposed: boolean;
  is_pii: boolean;
  column_count: number;
}

export interface EntityUpdateInput {
  display_name?: string;
  description?: string | null;
  synonyms?: string[];
  grain_description?: string | null;
  is_exposed?: boolean;
  is_pii?: boolean;
}

export interface EntityColumn {
  id: string;
  physical_name: string;
  display_name: string;
  description: string | null;
  synonyms: string[];
  data_type: string;
  ordinal: number;
  is_nullable: boolean;
  role: ColumnRole | null;
  semantic_type: SemanticType | null;
  default_aggregation: DefaultAggregation | null;
  is_exposed: boolean;
  is_pii: boolean;
  is_default_select: boolean;
  distinct_count: number | null;
  sample_values: unknown[];
  min_val: string | null;
  max_val: string | null;
  null_ratio: number | null;
  last_profiled_at: string | null;
}

export interface EntityColumnUpdateInput {
  display_name?: string;
  description?: string | null;
  synonyms?: string[];
  role?: ColumnRole | null;
  semantic_type?: SemanticType | null;
  default_aggregation?: DefaultAggregation | null;
  is_exposed?: boolean;
  is_pii?: boolean;
  is_default_select?: boolean;
}

export interface SqlQueryResult {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  row_count: number;
  elapsed_ms: number;
}

export interface SyncSummary {
  sources: number;
  entities_added: number;
  entities_deprecated: number;
  columns_synced: number;
}

export interface BrowseColumn {
  id: string;
  physical_name: string;
  display_name: string;
}

export interface BrowseEntity {
  id: string;
  physical_name: string;
  display_name: string;
  data_source_name: string;
  columns: BrowseColumn[];
}

export interface ColumnPair {
  id: string;
  from_column_id: string;
  from_column_name: string;
  to_column_id: string;
  to_column_name: string;
  seq: number;
}

export interface Relationship {
  id: string;
  from_entity_id: string;
  from_entity_name: string;
  to_entity_id: string;
  to_entity_name: string;
  cardinality: Cardinality;
  join_type_default: JoinType;
  is_curated: boolean;
  column_pairs: ColumnPair[];
}

export interface ColumnPairInput {
  from_column_id: string;
  to_column_id: string;
  seq: number;
}

export interface RelationshipCreateInput {
  from_entity_id: string;
  to_entity_id: string;
  cardinality: Cardinality;
  join_type_default: JoinType;
  column_pairs: ColumnPairInput[];
}






export interface DisplayColumn {
  column_id: string;
  physical_name: string;
  display_name: string;
  semantic_type: string | null;
  role: string | null;
}

export interface PipelineResult {
  question: string;
  success: boolean;
  sql?: string;
  rows?: Record<string, unknown>[];
  row_count?: number;
  display_columns?: DisplayColumn[];
  assumptions: string[];
  sanity_warnings?: string[];
  clarifying_question?: string | null;
}

// ── pipeline_v2 (SSE, slot-filling + enrichment) ──

export type ChartType =
  | "line" | "area" | "stacked_area"
  | "bar" | "bar_horizontal" | "stacked_bar" | "combo"
  | "pie" | "donut" | "treemap"
  | "scatter" | "stat" | "table";

export interface ChartSpec {
  id?: string;                   // present only for a saved chart (enables persisting edits)
  type: ChartType;
  title: string;
  description: string;
  x: string | null;
  y: string[];
  value_field?: string | null;   // for 'stat': the single metric column
  recommended: boolean;
  rows?: Record<string, unknown>[]; // this chart's OWN data (from a per-chart transform); falls
                                    // back to the shared result rows when absent
  transform_code?: string;        // the pandas transform that produced `rows` (for reference)
  // persisted toolbar edits (Edit fields / Edit colors)
  title_override?: string | null;
  x_override?: string | null;
  y_override?: string[] | null;
  color_overrides?: Record<string, string>;
  label_overrides?: Record<string, string>;
}

export interface V2DisplayColumn {
  physical_name: string;
  display_name: string;
  semantic_type: string | null;
  role: string | null;
}

// ── persisted conversation history ──

export interface ConversationSummary {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedChart {
  id: string;
  type: ChartType;
  title: string;
  description: string;
  x: string | null;
  y: string[];
  value_field: string | null;
  recommended: boolean;
  is_pinned: boolean;
  rows: Record<string, unknown>[]; // this chart's own data ([] = use the query-result rows)
  transform_code: string;
  title_override: string | null;
  x_override: string | null;
  y_override: string[] | null;
  color_overrides: Record<string, string>;
  label_overrides: Record<string, string>;
}

export interface SavedQueryResult {
  id: string;
  sub_id: string | null;
  sub_question: string | null;
  sql: string | null;
  row_count: number;
  rows: Record<string, unknown>[];
  display_columns: V2DisplayColumn[];
  charts: SavedChart[];
}

export interface SavedMessage {
  id: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  question: string | null;
  answer_markdown: string | null;
  is_decomposed: boolean;
  follow_up_questions: string[];
  query_results: SavedQueryResult[];
  // pipeline v4 answers: replayed with the same view as when they streamed
  standalone_question?: string | null;
  status?: string | null;
  events?: { type: V4EventType; data: Record<string, unknown>; t?: number | null }[];
  chart_ids?: (string | null)[];
}

export interface ConversationDetail {
  id: string;
  title: string | null;
  messages: SavedMessage[];
}

// Accumulated state of a v2 turn as events stream in. Fields fill progressively.
export interface V2Result {
  question: string;
  success: boolean;
  sql?: string;
  rows?: Record<string, unknown>[];
  row_count?: number;
  display_columns?: V2DisplayColumn[];
  assumptions?: string[];
  sanity_warnings?: string[];
  clarifying_question?: string | null;
  join_strategy?: string | null;
  // enrichment (arrive after the table result)
  answer_markdown?: string;     // streamed markdown answer + insights (accumulated from deltas)
  charts?: ChartSpec[];
  follow_up_questions?: string[];
}

// ── dashboards ──

export interface DashboardSummary {
  id: string;
  title: string;
  description: string;
  widget_count: number;
  updated_at: string;
}

// the chart resolved behind a chart-widget — same fields ChartView renders in chat
export interface WidgetChart {
  id: string;
  type: ChartType;
  title: string;
  description: string;
  x: string | null;
  y: string[];
  value_field: string | null;
  title_override: string | null;
  x_override: string | null;
  y_override: string[] | null;
  color_overrides: Record<string, string>;
  label_overrides: Record<string, string>;
  rows: Record<string, unknown>[];
  display_columns: V2DisplayColumn[];
}

export interface DashboardWidget {
  id: string;
  seq: number;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title_override: string | null;
  note: string | null;
  text: string | null;
  config: Record<string, unknown>;
  chart: WidgetChart | null;
}

export interface DashboardDetail {
  id: string;
  title: string;
  description: string;
  appearance: Record<string, unknown>;
  widgets: DashboardWidget[];
}

export interface AvailableChart {
  chart_id: string;
  type: ChartType;
  title: string;
  conversation_title: string | null;
  chart: WidgetChart | null;
}

// one widget's state sent to the bulk-save endpoint (id null = create new)
export interface WidgetLayoutInput {
  id: string | null;
  kind: string;
  chart_id: string | null;
  seq: number;
  x: number;
  y: number;
  w: number;
  h: number;
  title_override: string | null;
  note: string | null;
  text: string | null;
}

// ── data profile (pipeline v4, entered by people) ──

export type TableKind = "fact" | "dim" | "snapshot" | "scd2";
export type Trust = "certified" | "raw";
export type Additive = "all" | "not_time" | "none";
export type FilterOp =
  | "="
  | "!="
  | "in"
  | "not_in"
  | ">"
  | ">="
  | "<"
  | "<="
  | "is_null"
  | "is_not_null";

export interface TypedFilter {
  column_id: string;
  op: FilterOp;
  values: (string | number | boolean)[];
  reason: string | null;
}

export interface ValueCatalogItem {
  value: string;
  label: string | null;
  synonyms: string[];
  count: number | null;
}

export interface EntityProfile {
  table_kind: TableKind | null;
  trust: Trust | null;
  grain_key_column_ids: string[];
  label_column_id: string | null;
  time_column_id: string | null;
  storage_tz: string | null;
  business_tz: string | null;
  snapshot_column_id: string | null;
  coverage_start: string | null;
  coverage_end: string | null;
  coverage_gaps: string | null;
  default_filters: TypedFilter[];
  default_filters_confirmed: boolean;
  list_filters: TypedFilter[];
  caveats: string[];
  notes: string | null;
}

export type JsonFieldType = "BOOLEAN" | "VARCHAR" | "INTEGER" | "BIGINT" | "DOUBLE" | "DATE" | "TIMESTAMP";

/** A field inside a text column that holds JSON, e.g. config → is_intent_node. */
export interface JsonField {
  path: string;
  data_type: JsonFieldType;
  display_name: string | null;
  description: string | null;
  value_catalog: ValueCatalogItem[];
  value_catalog_complete: boolean;
}

export interface ColumnProfile {
  value_catalog: ValueCatalogItem[];
  value_catalog_complete: boolean;
  values_ordered: boolean;
  pattern: string | null;
  date_format: string | null;
  parent_column_id: string | null;
  unit: string | null;
  scale: number | null;
  additive: Additive | null;
  sign_convention: string | null;
  null_meaning: string | null;
  normal_min: number | null;
  normal_max: number | null;
  notes: string | null;
  json_fields: JsonField[];
}

export interface RelationshipProfile {
  match_rate: number | null;
  fanout_ratio: number | null;
  notes: string | null;
}

export interface ProfileReview {
  reviewed_by: string | null;
  reviewed_at: string | null;
  needs_review: boolean;
  needs_review_reasons: string[];
}

export interface ChecklistItem {
  level: "required" | "recommended";
  scope: "table" | "column" | "relationship";
  target_id: string;
  target_name: string;
  field: string;
  message: string;
}

export interface Checklist {
  required_done: number;
  required_total: number;
  recommended_done: number;
  recommended_total: number;
  missing: ChecklistItem[];
}

export interface ProfileEntityInfo {
  id: string;
  physical_name: string;
  physical_path: string;
  entity_type: string;
  display_name: string;
  description: string | null;
  synonyms: string[];
  grain_description: string | null;
  is_exposed: boolean;
  is_pii: boolean;
}

export interface ProfileColumn {
  id: string;
  physical_name: string;
  data_type: string;
  ordinal: number;
  display_name: string;
  description: string | null;
  synonyms: string[];
  role: ColumnRole | null;
  semantic_type: SemanticType | null;
  default_aggregation: DefaultAggregation | null;
  is_exposed: boolean;
  is_pii: boolean;
  profile: ColumnProfile;
}

export interface ProfileRelationship {
  id: string;
  direction: "from" | "to";
  from_entity_name: string;
  to_entity_name: string;
  other_entity_id: string;
  other_entity_name: string;
  cardinality: Cardinality | null;
  join_type_default: JoinType | null;
  pairs: { from_column: string; to_column: string }[];
  profile: RelationshipProfile;
}

export interface SearchIndexStatus {
  status: "never" | "ok" | "stale";
  error: string | null;
  updated_at: string | null;
}

export interface EntityProfileDetail {
  entity: ProfileEntityInfo;
  profile: EntityProfile;
  review: ProfileReview;
  columns: ProfileColumn[];
  relationships: ProfileRelationship[];
  checklist: Checklist;
  search_index: SearchIndexStatus;
}

export interface EntityProfileSummary {
  entity_id: string;
  display_name: string;
  physical_name: string;
  entity_type: string;
  column_count: number;
  table_kind: TableKind | null;
  required_done: number;
  required_total: number;
  recommended_done: number;
  recommended_total: number;
  review: ProfileReview;
  search_index: SearchIndexStatus;
}

export interface EntityProfileUpdateInput {
  display_name: string;
  description: string | null;
  synonyms: string[];
  grain_description: string | null;
  is_exposed: boolean;
  is_pii: boolean;
  profile: EntityProfile;
}

export interface ColumnProfileUpdateInput {
  display_name: string;
  description: string | null;
  synonyms: string[];
  role: ColumnRole | null;
  semantic_type: SemanticType | null;
  default_aggregation: DefaultAggregation | null;
  is_exposed: boolean;
  is_pii: boolean;
  profile: ColumnProfile;
}

export type SuggestionConfidence = "high" | "medium" | "low";

export type SuggestField =
  | "display_name"
  | "description"
  | "synonyms"
  | "grain_description"
  | "table_kind"
  | "trust"
  | "label_column"
  | "grain_keys"
  | "example_questions"
  | "aggregation"
  | "column";

export interface FieldSuggestion {
  value: string | null;
  synonyms: string[] | null;
  questions?: string[] | null;
  aggregation?: DefaultAggregation | null;
  column_id?: string | null;
  column_ids?: string[] | null; // grain keys
  confidence: SuggestionConfidence;
  note: string | null;
}

export interface ValueSuggestion {
  label: string;
  synonyms: string[];
  confidence: SuggestionConfidence;
  note: string | null;
}

// ── relationships between tables (pipeline v4; tables may be in different sources) ──

export interface TableOption {
  entity_id: string;
  display_name: string;
  physical_name: string;
  physical_path: string;
  entity_type: string;
  data_source_id: string;
  data_source_name: string;
}

export interface ColumnOption {
  id: string;
  physical_name: string;
  display_name: string;
  data_type: string;
  role: ColumnRole | null;
  is_grain_key: boolean;
}

export interface RelationshipTableRef {
  entity_id: string;
  display_name: string;
  physical_path: string;
  data_source_id: string;
  data_source_name: string;
}

export interface RelationshipItem {
  id: string;
  from_table: RelationshipTableRef;
  to_table: RelationshipTableRef;
  cardinality: Cardinality;
  join_type_default: JoinType;
  pairs: {
    from_column_id: string;
    from_column: string;
    from_type: string;
    to_column_id: string;
    to_column: string;
    to_type: string;
  }[];
  profile: RelationshipProfile;
  cross_source: boolean;
  warnings: string[];
  created_at: string | null;
}

export interface RelationshipItemInput {
  from_entity_id: string;
  to_entity_id: string;
  cardinality: Cardinality;
  join_type_default: JoinType;
  pairs: { from_column_id: string; to_column_id: string }[];
  profile: RelationshipProfile;
}

// ── metrics (pipeline v4) ──

export type MetricKind = "aggregate" | "ratio";

export interface ReferenceValue {
  period: string;
  value: number;
  source: string | null;
}

export interface MetricInput {
  name: string;
  display_name: string;
  description: string | null;
  synonyms: string[];
  kind: MetricKind;
  entity_id: string | null;
  aggregation: DefaultAggregation | null;
  column_id: string | null;
  filters: TypedFilter[];
  use_table_default_filters: boolean;
  time_column_id: string | null;
  numerator_metric_id: string | null;
  denominator_metric_id: string | null;
  ratio_scale: number;
  unit: string | null;
  additive: Additive | null;
  decimals: number | null;
  good_direction: "up" | "down" | "none" | null;
  example_questions: string[];
  reference_values: ReferenceValue[];
  notes: string | null;
}

export interface MetricItem extends MetricInput {
  id: string;
  disabled: boolean; // hidden from the agents
  table: {
    entity_id: string;
    display_name: string;
    physical_path: string;
    data_source_name: string;
    table_kind: TableKind | null;
  } | null;
  column_name: string | null;
  column_type: string | null;
  numerator_name: string | null;
  denominator_name: string | null;
  formula: string;
  table_default_filters: string[];
  checklist: {
    required_done: number;
    required_total: number;
    recommended_done: number;
    recommended_total: number;
    missing: { level: "required" | "recommended"; field: string; message: string }[];
  };
  search_index: { status?: string; error?: string | null };
  created_at: string | null;
  updated_at: string | null;
}

export interface MetricRunResult {
  value: number | null;
  parts: { label: string; sql: string; value: number | null }[];
  elapsed_ms: number;
  period: string | null;
  reference: { value: number; source: string | null; diff_pct: number | null } | null;
  notes: string[];
}

// ── business glossary (pipeline v4) ──

export type TermKind = "segment" | "metric" | "definition";

export interface GlossaryInput {
  term: string;
  synonyms: string[];
  definition: string | null;
  kind: TermKind;
  entity_id: string | null;
  filters: TypedFilter[];
  metric_id: string | null;
  related_entity_ids: string[];
  example_questions: string[];
  notes: string | null;
}

export interface GlossaryTableRef {
  entity_id: string;
  display_name: string;
  physical_path: string;
  data_source_name: string;
}

export interface GlossaryItem extends GlossaryInput {
  id: string;
  disabled: boolean; // hidden from the agents
  table: GlossaryTableRef | null;
  related_tables: GlossaryTableRef[];
  metric_name: string | null;
  metric_display_name: string | null;
  meaning: string;
  checklist: {
    required_done: number;
    required_total: number;
    recommended_done: number;
    recommended_total: number;
    missing: { level: "required" | "recommended"; field: string; message: string }[];
  };
  search_index: { status?: string; error?: string | null };
  created_at: string | null;
  updated_at: string | null;
}

// ── pipeline v4 (POST /chat/ask_v4, SSE) ──

export type V4StepName = "understand" | "find" | "plan" | "run" | "present";

export type V4EventType =
  | "step"
  | "agent_started"
  | "agent_delta"
  | "tool_started"
  | "tool_done"
  | "agent_done"
  | "answer_delta"
  | "answer_reset"
  | "keywords"
  | "intent"
  | "spec_errors"
  | "sql"
  | "result"
  | "answer"
  | "charts"
  | "follow_ups"
  | "timings"
  | "error"
  | "done"
  | "saved"
  | "save_error"
  | "decompose"
  | "compressed";

export interface V4Event {
  type: V4EventType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface V4OutputColumn {
  name: string;
  kind: "dimension" | "label" | "metric" | "derived" | "column";
  column_id: string | null;
  metric_id: string | null;
  unit: string | null;
  time_grain: string | null;
}

export interface V4Chart {
  type: ChartType;
  title: string;
  recommended: boolean;
  x?: string;
  y?: string[];
  columns?: string[];
  value?: unknown;
  unit?: string | null;
  units?: Record<string, string>;
  rows?: Record<string, unknown>[];
  part?: string;                 // the sub-question it belongs to (q1, q2, …)
  data?: string;                 // the dataset it draws: original (the query result) or a transform (d1, …)
  labels?: Record<string, string>; // what to show for each field (axes, legend, headers), from the profile
}

export interface V4FollowUp {
  question: string;
  based_on: string[];
}

export interface V4Timing {
  name: string;
  seconds: number;
  ok: boolean;
  children: V4Timing[];
}

// ── profile export / import ──

export interface ImportItem {
  name: string;
  action: "create" | "update" | "skip";
  problems: string[];
}

export interface ImportReport {
  kind: "tables" | "relationships" | "metrics" | "glossary";
  dry_run: boolean;
  items: ImportItem[];
  created: number;
  updated: number;
  skipped: number;
  not_indexed: string[]; // saved, but the search index failed: rebuild it
}
