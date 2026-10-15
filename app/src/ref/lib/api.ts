// Copied from bot-data-studio-web-main/src/lib/api.ts by scripts/sync-ref-profile.mjs — edit there, not here.
import { refFetch, oursGetEntities, oursUpdateEntity } from "@/shims/fetch";
import type {
  V4Event,
  V4EventType,
  AvailableDremioSource,
  BrowseEntity,
  DremioDataset,
  DataSource,
  Entity,
  EntityColumn,
  EntityColumnUpdateInput,
  EntityUpdateInput,
  SqlQueryResult,
  SyncSummary,
  ConversationSummary,
  ConversationDetail,
  SavedChart,
  DashboardSummary,
  DashboardDetail,
  AvailableChart,
  WidgetLayoutInput,
  ColumnProfileUpdateInput,
  EntityProfileDetail,
  EntityProfileSummary,
  EntityProfileUpdateInput,
  RelationshipProfile,
  FieldSuggestion,
  ValueSuggestion,
  ColumnOption,
  RelationshipItem,
  RelationshipItemInput,
  TableOption,
  MetricInput,
  MetricItem,
  MetricRunResult,
  GlossaryInput,
  GlossaryItem,
  TypedFilter,
  SuggestField,
  ImportReport,
} from "@/lib/types";

// FastAPI sends `detail` as a string, a list of strings (our 400s) or a list of {msg} (422s)
function errorDetail(detail: unknown): string | null {
  if (!detail) return null;
  if (Array.isArray(detail)) {
    return detail
      .map((d) =>
        typeof d === "string"
          ? d
          : ((d as { msg?: string }).msg ?? JSON.stringify(d)),
      )
      .join("\n");
  }
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send Content-Type with a body: on a cross-origin GET it's a non-simple header that
  // makes the browser send a CORS preflight (OPTIONS) before every request.
  const res = await refFetch(path, {
    credentials: "include",
    ...init,
    headers: init?.body
      ? { "Content-Type": "application/json", ...init.headers }
      : init?.headers,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      errorDetail(data.detail) ?? `Request failed: ${res.status}`,
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

/** Download the data source's profile as a Word document (Vietnamese) for a data engineer to fill in. */
export function downloadDataSourceDocx(dataSourceId: string, fallbackName: string) {
  return downloadFile(`/data-profile/data-sources/${dataSourceId}/export.docx`, `ho-so-du-lieu-${fallbackName}.docx`);
}

/** Save a file the API sends as an attachment, under the server's file name. */
export async function downloadFile(path: string, fallbackName: string) {
  const res = await refFetch(path, { credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(errorDetail(data.detail) ?? `Export failed: ${res.status}`);
  }
  // the server's file name (Content-Disposition filename*), else a default
  const header = res.headers.get("Content-Disposition") ?? "";
  const match = /filename\*=UTF-8''([^;]+)/.exec(header);
  const name = match ? decodeURIComponent(match[1]) : fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function getAvailableDremioSources() {
  return apiFetch<AvailableDremioSource[]>("/sync/dremio/available");
}

export function getDremioSourceDatasets(sourceName: string) {
  return apiFetch<DremioDataset[]>(
    `/sync/dremio/sources/${encodeURIComponent(sourceName)}/datasets`,
  );
}

export function syncDremioDatasets(datasets: string[][]) {
  return apiFetch<SyncSummary>("/sync/dremio", {
    method: "POST",
    body: JSON.stringify({ datasets }),
  });
}

export function runSqlQuery(sql: string, limit: number) {
  return apiFetch<SqlQueryResult>("/sql/query", {
    method: "POST",
    body: JSON.stringify({ sql, limit }),
  });
}

export function getDataSources() {
  return apiFetch<DataSource[]>("/data-sources");
}

export function deleteDataSource(dataSourceId: string) {
  return apiFetch<void>(`/data-sources/${dataSourceId}`, { method: "DELETE" });
}

/** Turn a data source on or off for the agents (its tables, metrics and terms with it). */
export function setDataSourceEnabled(dataSourceId: string, enabled: boolean) {
  return apiFetch<void>(`/data-sources/${dataSourceId}/enabled`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export function getEntities(dataSourceId: string) {
  return oursGetEntities(dataSourceId);
}

export function updateEntity(entityId: string, input: EntityUpdateInput) {
  return oursUpdateEntity(entityId, input);
}

export function getEntityColumns(entityId: string) {
  return apiFetch<EntityColumn[]>(`/data-sources/entities/${entityId}/columns`);
}

export function updateEntityColumn(
  columnId: string,
  input: EntityColumnUpdateInput,
) {
  return apiFetch<EntityColumn>(`/data-sources/entities/columns/${columnId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function getBrowseEntities() {
  return apiFetch<BrowseEntity[]>("/relationships/browse-entities");
}





/**
 * Streams pipeline v4 from POST /chat/ask_v4 over SSE: every step, agent run (keyed by run_id),
 * tool call, text piece, then sql, result, answer, charts, follow-ups, timings and done.
 */
export async function askQuestionV4(
  question: string,
  onEvent: (event: V4Event) => void,
  signal?: AbortSignal,
  conversationId?: string | null,
): Promise<void> {
  const res = await refFetch(`/chat/ask_v4`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    // with a conversation id the answer is saved into that conversation, else a new one starts
    body: JSON.stringify({ question, conversation_id: conversationId ?? null }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? `Request failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:"));
      const dataText = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).trim())
        .join("\n");
      if (!eventLine || !dataText) continue;
      try {
        onEvent({ type: eventLine.slice("event:".length).trim() as V4EventType, data: JSON.parse(dataText) });
      } catch {
        // a malformed frame is skipped, not fatal
      }
    }
  }
}


// ── conversation history ──

export function getConversations() {
  return apiFetch<ConversationSummary[]>("/chat/conversations");
}

export function getConversation(id: string) {
  return apiFetch<ConversationDetail>(`/chat/conversations/${id}`);
}

// persist chart toolbar edits (Edit fields / Edit colors). Only saved charts have an id.
export function updateChart(
  chartId: string,
  update: {
    title_override?: string | null;
    x_override?: string | null;
    y_override?: string[] | null;
    color_overrides?: Record<string, string>;
    label_overrides?: Record<string, string>;
  },
) {
  return apiFetch<SavedChart>(`/chat/charts/${chartId}`, {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}

// ── dashboards ──

export function getDashboards() {
  return apiFetch<DashboardSummary[]>("/dashboards");
}

export function getDashboard(id: string) {
  return apiFetch<DashboardDetail>(`/dashboards/${id}`);
}

export function createDashboard(input: {
  title?: string;
  description?: string;
}) {
  return apiFetch<DashboardDetail>("/dashboards", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateDashboard(
  id: string,
  input: {
    title?: string;
    description?: string;
    appearance?: Record<string, unknown>;
  },
) {
  return apiFetch<DashboardDetail>(`/dashboards/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteDashboard(id: string) {
  return apiFetch<{ deleted: boolean }>(`/dashboards/${id}`, {
    method: "DELETE",
  });
}

// pin a chat chart into a dashboard ("Thêm vào dashboard")
export function pinChartToDashboard(dashboardId: string, chartId: string) {
  return apiFetch<DashboardDetail>(`/dashboards/${dashboardId}/charts`, {
    method: "POST",
    body: JSON.stringify({ chart_id: chartId }),
  });
}

// ── builder ──

export function getAvailableCharts() {
  return apiFetch<AvailableChart[]>("/dashboards/meta/available-charts");
}

export function addDashboardWidget(
  dashboardId: string,
  input: { kind: string; chart_id?: string; text?: string; title?: string },
) {
  return apiFetch<DashboardDetail>(`/dashboards/${dashboardId}/widgets`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function saveDashboardWidgets(
  dashboardId: string,
  widgets: WidgetLayoutInput[],
) {
  return apiFetch<DashboardDetail>(`/dashboards/${dashboardId}/widgets`, {
    method: "PUT",
    body: JSON.stringify({ widgets }),
  });
}

// export the dashboard to PDF. The FE ships per-widget rendered images (PNG data URIs) + layout;
// the server (WeasyPrint) lays them out. Returns the PDF blob.
export interface PdfWidgetPayload {
  kind?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  title?: string | null;
  note?: string | null;
  text?: string | null;
  png?: string | null;
  svg?: string | null;
  chart_type?: string | null;
  columns?: Record<string, unknown>[];
  rows?: Record<string, unknown>[];
}

export async function exportDashboardPdf(
  id: string,
  payload: {
    title?: string;
    description?: string;
    appearance?: Record<string, unknown>;
    widgets: PdfWidgetPayload[];
  },
): Promise<Blob> {
  const res = await refFetch(`/dashboards/${id}/pdf`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? `PDF export failed: ${res.status}`);
  }
  return res.blob();
}

// ── data profile (pipeline v4) ──

export function getEntityProfileSummaries(dataSourceId: string) {
  return apiFetch<EntityProfileSummary[]>(
    `/data-profile/data-sources/${dataSourceId}/entities`,
  );
}

export function getEntityProfile(entityId: string) {
  return apiFetch<EntityProfileDetail>(`/data-profile/entities/${entityId}`);
}

export function updateEntityProfile(
  entityId: string,
  input: EntityProfileUpdateInput,
) {
  return apiFetch<EntityProfileDetail>(`/data-profile/entities/${entityId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function updateColumnProfile(
  entityId: string,
  columnId: string,
  input: ColumnProfileUpdateInput,
) {
  return apiFetch<EntityProfileDetail>(
    `/data-profile/entities/${entityId}/columns/${columnId}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export function updateColumnProfiles(
  entityId: string,
  items: (ColumnProfileUpdateInput & { id: string })[],
) {
  return apiFetch<EntityProfileDetail>(
    `/data-profile/entities/${entityId}/columns`,
    {
      method: "PUT",
      body: JSON.stringify(items),
    },
  );
}

export function updateRelationshipProfile(
  entityId: string,
  relationshipId: string,
  input: RelationshipProfile,
) {
  return apiFetch<EntityProfileDetail>(
    `/data-profile/entities/${entityId}/relationships/${relationshipId}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function markEntityProfileReviewed(entityId: string) {
  return apiFetch<EntityProfileDetail>(
    `/data-profile/entities/${entityId}/review`,
    {
      method: "POST",
    },
  );
}

export function reindexEntityProfile(entityId: string) {
  return apiFetch<EntityProfileDetail>(
    `/data-profile/entities/${entityId}/reindex`,
    {
      method: "POST",
    },
  );
}

export function reindexDataSourceProfiles(dataSourceId: string) {
  return apiFetch<{ tables: number; ok: number; stale: number }>(
    `/data-profile/data-sources/${dataSourceId}/reindex`,
    { method: "POST" },
  );
}

export function suggestProfileField(
  entityId: string,
  input: {
    target: "table" | "column";
    field: SuggestField;
    column_id?: string | null;
    draft: Record<string, unknown>;
  },
) {
  return apiFetch<FieldSuggestion>(
    `/data-profile/entities/${entityId}/suggest-field`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function suggestProfileValue(
  entityId: string,
  input: {
    column_id: string;
    value: string;
    draft: {
      display_name?: string;
      description?: string | null;
      values: { value: string; label: string | null }[];
    };
  },
) {
  return apiFetch<ValueSuggestion>(
    `/data-profile/entities/${entityId}/suggest-value`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

// ── relationships (pipeline v4) ──

export function getProfileTables() {
  return apiFetch<TableOption[]>("/data-profile/tables");
}

export function getTableColumnOptions(entityId: string) {
  return apiFetch<ColumnOption[]>(`/data-profile/tables/${entityId}/columns`);
}

export function getRelationshipItems() {
  return apiFetch<RelationshipItem[]>("/data-profile/relationships");
}

export function createRelationshipItem(input: RelationshipItemInput) {
  return apiFetch<RelationshipItem>("/data-profile/relationships", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateRelationshipItem(
  id: string,
  input: RelationshipItemInput,
) {
  return apiFetch<RelationshipItem>(`/data-profile/relationships/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteRelationshipItem(id: string) {
  return apiFetch<void>(`/data-profile/relationships/${id}`, {
    method: "DELETE",
  });
}

// ── metrics (pipeline v4) ──

export function getProfileMetrics() {
  return apiFetch<MetricItem[]>("/data-profile/metrics");
}

export function createProfileMetric(input: MetricInput) {
  return apiFetch<MetricItem>("/data-profile/metrics", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateProfileMetric(id: string, input: MetricInput) {
  return apiFetch<MetricItem>(`/data-profile/metrics/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteProfileMetric(id: string) {
  return apiFetch<void>(`/data-profile/metrics/${id}`, { method: "DELETE" });
}

/** Turn a metric on or off for the agents. */
export function setProfileMetricEnabled(id: string, enabled: boolean) {
  return apiFetch<MetricItem>(`/data-profile/metrics/${id}/enabled`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export function suggestMetricField(
  field: "description" | "synonyms" | "example_questions",
  draft: Record<string, unknown>,
) {
  return apiFetch<FieldSuggestion>("/data-profile/metrics/suggest-field", {
    method: "POST",
    body: JSON.stringify({ field, draft }),
  });
}

export function suggestMetricCalculation(
  field: "aggregation" | "column",
  draft: Record<string, unknown>,
) {
  return apiFetch<FieldSuggestion>(
    "/data-profile/metrics/suggest-calculation",
    {
      method: "POST",
      body: JSON.stringify({ field, draft }),
    },
  );
}

/** Build the metric's SQL from the form and run it once on Dremio (read-only). */
export function runProfileMetric(
  draft: Record<string, unknown>,
  period: string | null,
) {
  return apiFetch<MetricRunResult>("/data-profile/metrics/run", {
    method: "POST",
    body: JSON.stringify({ draft, period }),
  });
}

// ── business glossary (pipeline v4) ──

export function getGlossaryItems() {
  return apiFetch<GlossaryItem[]>("/data-profile/glossary");
}

export function createGlossaryItem(input: GlossaryInput) {
  return apiFetch<GlossaryItem>("/data-profile/glossary", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateGlossaryItem(id: string, input: GlossaryInput) {
  return apiFetch<GlossaryItem>(`/data-profile/glossary/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteGlossaryItem(id: string) {
  return apiFetch<void>(`/data-profile/glossary/${id}`, { method: "DELETE" });
}

/** Turn a glossary term on or off for the agents. */
export function setGlossaryItemEnabled(id: string, enabled: boolean) {
  return apiFetch<GlossaryItem>(`/data-profile/glossary/${id}/enabled`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export function suggestGlossaryField(
  field: "definition" | "synonyms" | "example_questions",
  draft: Record<string, unknown>,
) {
  return apiFetch<FieldSuggestion>("/data-profile/glossary/suggest-field", {
    method: "POST",
    body: JSON.stringify({ field, draft }),
  });
}

/** Count the rows in a segment once on Dremio (read-only). */
export function runGlossarySegment(entityId: string, filters: TypedFilter[], period: string | null) {
  return apiFetch<MetricRunResult>("/data-profile/glossary/run", {
    method: "POST",
    body: JSON.stringify({ entity_id: entityId, filters, period }),
  });
}

/** Count the rows that have a JSON field (counts only), once, when a person clicks Check. */
export function checkJsonField(entityId: string, columnId: string, path: string, dataType: string) {
  return apiFetch<{ total_rows: number; rows_with_value: number; sql: string }>(
    `/data-profile/entities/${entityId}/columns/${columnId}/check-json-field`,
    { method: "POST", body: JSON.stringify({ path, data_type: dataType }) },
  );
}

/** Import an exported profile file (tables of a source, relationships, metrics or glossary).
 *  dryRun: only check it and report what would happen. */
export function importProfileFile(path: string, file: unknown, dryRun: boolean) {
  return apiFetch<ImportReport>(`${path}?dry_run=${dryRun}`, { method: "POST", body: JSON.stringify(file) });
}
