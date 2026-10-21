// docs/data-studio-admin-ui-plan.md — Data Sources section (Phase 3, part 1).
// 3-level drill-down (sources -> entities -> columns), same "local state
// swaps the view" pattern ProjectHub.tsx already uses instead of adding more
// URL routes for this. Real CRUD against services/gateway's new
// /data-studio/* routes (data-studio-db.ts) — no mock data.
//
// 2026-10-20 redesign (user: the tab was raw — the import button did not stand out, the Dremio results and the
// checkboxes were plain): the import is the primary (brand) action; sources, the Dremio picker and imported tables
// are cards with their key facts up front (tables per source, columns and rows per table, status, last sync);
// selection is a whole clickable card with a check mark; on/off settings are switches. Logic and API unchanged.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  DataSourcesIcon,
  DataStudioIcon,
  SearchIcon,
  TableIcon,
  TrashIcon,
} from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { Input } from "../../primitives/Input.tsx";

// Real field shapes — services/gateway/src/data-studio-db.ts's row types,
// mirrored here (JSON over the wire, so `synonyms`/etc. arrive as strings).
interface DataSource {
  id: string;
  name: string;
  source_type: string;
  dremio_path: string;
  status: string;
  last_synced_at?: string | null;
  is_exposed_to_agent: 0 | 1;
  entity_count?: number;
}
interface Entity {
  id: string;
  data_source_id: string;
  physical_name: string;
  physical_path?: string;
  entity_type?: string;
  display_name: string;
  description: string | null;
  synonyms: string;
  grain_description: string | null;
  is_exposed: 0 | 1;
  is_pii: 0 | 1;
  // Role `user` may query this table (services/gateway's role gate). Admins always can.
  allow_user: 0 | 1;
  row_count_est?: number | null;
  column_count?: number;
}
interface EntityColumn {
  id: string;
  entity_id: string;
  physical_name: string;
  data_type: string;
  display_name: string;
  description: string | null;
  synonyms: string;
  role: string | null;
  semantic_type: string | null;
  default_aggregation: string | null;
  is_exposed: 0 | 1;
  is_pii: 0 | 1;
  is_default_select: 0 | 1;
  // Role `user` may see this column. Never for a PII column, whatever this says.
  allow_user: 0 | 1;
}

const ROLE_OPTIONS = ["", "dimension", "measure", "key"];
const SEMANTIC_TYPE_OPTIONS = ["", "currency", "date", "datetime", "category", "id", "percent", "count", "number", "text", "pii", "boolean"];
const AGGREGATION_OPTIONS = ["", "sum", "avg", "count", "count_distinct", "min", "max"];

function parseJsonArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

interface DremioDataset {
  path: string[];
  schema_name: string;
  name: string;
  type: string;
  imported: boolean;
}

/** An on/off setting: a switch with its label, saved as soon as it flips (the parent reloads the row). */
function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  compact,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  // shown at once, corrected by the reload that follows the save
  const [on, setOn] = useState(checked);
  useEffect(() => setOn(checked), [checked]);
  return (
    <label className={`fh-ds-switch${compact ? " fh-ds-switch-compact" : ""}${disabled ? " fh-ds-switch-disabled" : ""}`} title={hint}>
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => {
          setOn(event.target.checked);
          onChange(event.target.checked);
        }}
      />
      <span className="fh-ds-switch-track" aria-hidden="true">
        <span className="fh-ds-switch-thumb" />
      </span>
      {label && !compact && <span className="fh-ds-switch-label">{label}</span>}
    </label>
  );
}

/** A card the whole of which toggles a selection, with a check mark in its corner. */
function SelectCard({ selected, onToggle, children }: { selected: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`fh-ds-select-card${selected ? " fh-ds-select-card-on" : ""}`} aria-pressed={selected} onClick={onToggle}>
      <span className="fh-ds-check" aria-hidden="true">{selected && <CheckIcon size={12} strokeWidth={3} />}</span>
      <span className="fh-ds-select-card-body">{children}</span>
    </button>
  );
}

function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "success" | "muted" | "danger"; children: ReactNode }) {
  return <span className={`fh-ds-badge fh-ds-badge-${tone}`}>{children}</span>;
}

const formatCount = (n: number, locale: string) => n.toLocaleString(locale === "vi" ? "vi-VN" : "en-US");

export function DataStudioDataSources() {
  const runtime = useRuntime();
  const { t, locale } = useLocale();
  const [sources, setSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [columns, setColumns] = useState<EntityColumn[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [browseResults, setBrowseResults] = useState<{ name: string; type: string }[] | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [selectedDremioNames, setSelectedDremioNames] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<Record<string, number> | null>(null);
  const [reindexSummary, setReindexSummary] = useState<Record<string, number> | null>(null);
  // Dataset picker: the tables of one Dremio source, imported one by one instead of the whole source.
  const [datasetSource, setDatasetSource] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<DremioDataset[] | null>(null);
  const [pickedDatasets, setPickedDatasets] = useState<Set<string>>(new Set());
  const [entityQuery, setEntityQuery] = useState("");
  const [datasetQuery, setDatasetQuery] = useState("");
  const dateLocale = locale === "vi" ? "vi-VN" : "en-US";

  const loadSources = useCallback(async () => {
    setLoading(true);
    const res = await runtime.authedFetch("/data-studio/sources");
    if (res.ok) setSources(await res.json());
    setLoading(false);
  }, [runtime]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const loadEntities = useCallback(
    async (sourceId: string) => {
      const res = await runtime.authedFetch(`/data-studio/sources/${sourceId}/entities`);
      if (res.ok) setEntities(await res.json());
    },
    [runtime],
  );

  const loadColumns = useCallback(
    async (entityId: string) => {
      const res = await runtime.authedFetch(`/data-studio/entities/${entityId}/columns`);
      if (res.ok) setColumns(await res.json());
    },
    [runtime],
  );

  async function toggleSourceExposed(source: DataSource): Promise<void> {
    await runtime.authedFetch(`/data-studio/sources/${source.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_exposed_to_agent: !source.is_exposed_to_agent }),
    });
    await loadSources();
  }

  async function saveEntity(entity: Entity, patch: Partial<Entity>): Promise<void> {
    const body: Record<string, unknown> = { ...patch };
    if ("synonyms" in patch) body.synonyms = parseJsonArray(patch.synonyms as string);
    if ("is_exposed" in patch) body.is_exposed = !!patch.is_exposed;
    if ("is_pii" in patch) body.is_pii = !!patch.is_pii;
    const res = await runtime.authedFetch(`/data-studio/entities/${entity.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) await loadEntities(entity.data_source_id);
  }

  async function saveColumn(column: EntityColumn, patch: Partial<EntityColumn>): Promise<void> {
    const body: Record<string, unknown> = { ...patch };
    if ("synonyms" in patch) body.synonyms = parseJsonArray(patch.synonyms as string);
    for (const boolField of ["is_exposed", "is_pii", "is_default_select"] as const) {
      if (boolField in patch) body[boolField] = !!patch[boolField];
    }
    const res = await runtime.authedFetch(`/data-studio/columns/${column.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) await loadColumns(column.entity_id);
  }

  // "Cho phép role user" on a table also opens (or closes) every non-PII column of it in the same PATCH
  // (`allow_user_columns`), so opening a table is one click; single columns can be closed again below.
  async function setEntityAllowUser(entity: Entity, allow: boolean): Promise<void> {
    const res = await runtime.authedFetch(`/data-studio/entities/${entity.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow_user: allow, allow_user_columns: true }),
    });
    if (!res.ok) toast.error(t("dataStudio.allowUserFailed"));
    await loadEntities(entity.data_source_id);
  }

  async function setColumnAllowUser(column: EntityColumn, allow: boolean): Promise<void> {
    const res = await runtime.authedFetch(`/data-studio/columns/${column.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow_user: allow }),
    });
    if (!res.ok) toast.error(t("dataStudio.allowUserFailed"));
    await loadColumns(column.entity_id);
  }

  async function browseDremio(): Promise<void> {
    setBrowsing(true);
    setBrowseError(null);
    setSyncSummary(null);
    const res = await runtime.authedFetch("/data-studio/dremio/browse", { method: "POST" });
    const body = await res.json();
    setBrowsing(false);
    if (!res.ok) {
      setBrowseError(body.error ?? "unknown error");
      return;
    }
    setBrowseResults(body.sources ?? []);
    setSelectedDremioNames(new Set());
  }

  async function openDatasets(sourceName: string): Promise<void> {
    setDatasetSource(sourceName);
    setDatasets(null);
    setPickedDatasets(new Set());
    setDatasetQuery("");
    setBrowseError(null);
    const res = await runtime.authedFetch(`/data-studio/dremio/sources/${encodeURIComponent(sourceName)}/datasets`);
    const body = await res.json();
    if (!res.ok) {
      setBrowseError(body.error ?? "unknown error");
      setDatasetSource(null);
      return;
    }
    setDatasets(body.datasets ?? []);
  }

  async function importDatasets(): Promise<void> {
    if (!datasets || pickedDatasets.size === 0) return;
    setSyncing(true);
    setBrowseError(null);
    const res = await runtime.authedFetch("/data-studio/dremio/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasets: datasets.filter((d) => pickedDatasets.has(d.path.join("."))).map((d) => d.path) }),
    });
    const body = await res.json();
    setSyncing(false);
    if (!res.ok) {
      setBrowseError(body.error ?? "unknown error");
      return;
    }
    setSyncSummary(body.summary ?? null);
    setReindexSummary(body.reindexSummary ?? null);
    setDatasetSource(null);
    setDatasets(null);
    setBrowseResults(null);
    await loadSources();
  }

  async function deleteSource(source: DataSource): Promise<void> {
    if (!window.confirm(t("dataStudio.deleteSourceConfirm", { name: source.name }))) return;
    const res = await runtime.authedFetch(`/data-studio/sources/${source.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setBrowseError(body.error ?? "unknown error");
      return;
    }
    await loadSources();
  }

  async function syncSelected(): Promise<void> {
    if (selectedDremioNames.size === 0) return;
    setSyncing(true);
    setBrowseError(null);
    const res = await runtime.authedFetch("/data-studio/dremio/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_names: [...selectedDremioNames] }),
    });
    const body = await res.json();
    setSyncing(false);
    if (!res.ok) {
      setBrowseError(body.error ?? "unknown error");
      return;
    }
    setSyncSummary(body.summary ?? null);
    setReindexSummary(body.reindexSummary ?? null);
    setBrowseResults(null);
    await loadSources();
  }

  const toggleIn = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const visibleEntities = useMemo(() => {
    const q = entityQuery.trim().toLowerCase();
    if (!q) return entities;
    return entities.filter((e) => [e.physical_name, e.display_name, e.description ?? ""].some((s) => s.toLowerCase().includes(q)));
  }, [entities, entityQuery]);

  const visibleDatasets = useMemo(() => {
    const q = datasetQuery.trim().toLowerCase();
    if (!datasets || !q) return datasets;
    return datasets.filter((d) => `${d.schema_name}.${d.name}`.toLowerCase().includes(q));
  }, [datasets, datasetQuery]);

  const selectedEntity = entities.find((e) => e.id === selectedEntityId) ?? null;
  const selectedSource = sources.find((s) => s.id === selectedSourceId) ?? null;

  if (loading) return <div className="fh-data-studio-loading">{t("dataStudio.loading")}</div>;

  // Level 2: columns of a selected entity.
  if (selectedEntity) {
    return (
      <div className="fh-data-studio-admin">
        <button
          type="button"
          className="fh-data-studio-crumb-back"
          onClick={() => {
            setSelectedEntityId(null);
            setColumns([]);
          }}
        >
          <ArrowLeftIcon size={14} /> {selectedSource?.name}
        </button>
        <div className="fh-ds-page-head">
          <div className="fh-ds-page-icon"><TableIcon size={20} /></div>
          <div>
            <h2 className="fh-ds-page-title">{selectedEntity.display_name || selectedEntity.physical_name}</h2>
            <div className="fh-ds-page-meta">
              <span className="fh-data-studio-mono">{selectedEntity.physical_name}</span>
              <Badge tone="accent">{t("dataStudio.columnCount", { n: String(columns.length) })}</Badge>
            </div>
          </div>
        </div>
        <div className="fh-ds-table-wrap">
          <table className="fh-data-studio-table fh-ds-columns">
            <thead>
              <tr>
                <th>{t("dataStudio.colPhysical")}</th>
                <th>{t("dataStudio.colDisplayName")}</th>
                <th>{t("dataStudio.colDescription")}</th>
                <th>{t("dataStudio.colRole")}</th>
                <th>{t("dataStudio.colSemanticType")}</th>
                <th>{t("dataStudio.colAggregation")}</th>
                <th className="fh-ds-center">{t("dataStudio.colExposed")}</th>
                <th className="fh-ds-center">{t("dataStudio.colPii")}</th>
                <th className="fh-ds-center">{t("dataStudio.colAllowUser")}</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr key={column.id}>
                  <td>
                    <div className="fh-data-studio-mono fh-ds-strong">{column.physical_name}</div>
                    <Badge tone="muted">{column.data_type}</Badge>
                  </td>
                  <td>
                    <Input
                      defaultValue={column.display_name}
                      onBlur={(e) => e.target.value !== column.display_name && saveColumn(column, { display_name: e.target.value })}
                    />
                  </td>
                  <td>
                    <Input
                      defaultValue={column.description ?? ""}
                      onBlur={(e) => e.target.value !== (column.description ?? "") && saveColumn(column, { description: e.target.value || null })}
                    />
                  </td>
                  <td>
                    <select className="fh-ds-select" defaultValue={column.role ?? ""} onChange={(e) => saveColumn(column, { role: e.target.value || null })}>
                      {ROLE_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>{opt || "—"}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select className="fh-ds-select" defaultValue={column.semantic_type ?? ""} onChange={(e) => saveColumn(column, { semantic_type: e.target.value || null })}>
                      {SEMANTIC_TYPE_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>{opt || "—"}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select className="fh-ds-select" defaultValue={column.default_aggregation ?? ""} onChange={(e) => saveColumn(column, { default_aggregation: e.target.value || null })}>
                      {AGGREGATION_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>{opt || "—"}</option>
                      ))}
                    </select>
                  </td>
                  <td className="fh-ds-center">
                    <Switch compact label={t("dataStudio.colExposed")} checked={!!column.is_exposed} onChange={(on) => void saveColumn(column, { is_exposed: on ? 1 : 0 })} />
                  </td>
                  <td className="fh-ds-center">
                    <Switch compact label={t("dataStudio.colPii")} checked={!!column.is_pii} onChange={(on) => void saveColumn(column, { is_pii: on ? 1 : 0 })} />
                  </td>
                  <td className="fh-ds-center">
                    <Switch
                      compact
                      label={t("dataStudio.colAllowUser")}
                      checked={!column.is_pii && !!column.allow_user}
                      disabled={!!column.is_pii}
                      hint={column.is_pii ? t("dataStudio.piiNeverVisible") : undefined}
                      onChange={(on) => void setColumnAllowUser(column, on)}
                    />
                  </td>
                </tr>
              ))}
              {columns.length === 0 && (
                <tr>
                  <td colSpan={9} className="fh-data-studio-empty">{t("dataStudio.noColumns")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="ds-muted fh-ds-footnote">{t("dataStudio.piiNeverVisible")}</p>
      </div>
    );
  }

  // Level 1: entities of a selected source, as cards.
  if (selectedSourceId !== null) {
    return (
      <div className="fh-data-studio-admin">
        <button
          type="button"
          className="fh-data-studio-crumb-back"
          onClick={() => {
            setSelectedSourceId(null);
            setEntities([]);
            setEntityQuery("");
          }}
        >
          <ArrowLeftIcon size={14} /> {t("dataStudio.sectionDataSources")}
        </button>
        <div className="fh-ds-page-head">
          <div className="fh-ds-page-icon"><DataSourcesIcon size={20} /></div>
          <div className="fh-ds-grow">
            <h2 className="fh-ds-page-title">{selectedSource?.name}</h2>
            <div className="fh-ds-page-meta">
              {selectedSource && <Badge>{selectedSource.source_type}</Badge>}
              <Badge tone="accent">{t("dataStudio.tableCount", { n: String(entities.length) })}</Badge>
              {selectedSource && <span className="fh-data-studio-mono">{selectedSource.dremio_path}</span>}
            </div>
          </div>
          <label className="fh-ds-search">
            <SearchIcon size={14} />
            <input value={entityQuery} onChange={(e) => setEntityQuery(e.target.value)} placeholder={t("dataStudio.searchTables")} />
          </label>
        </div>

        {visibleEntities.length === 0 ? (
          <div className="fh-ds-empty">{entities.length === 0 ? t("dataStudio.noEntities") : t("dataStudio.noMatch")}</div>
        ) : (
          <div className="fh-ds-entity-grid">
            {visibleEntities.map((entity) => (
              <article key={entity.id} className={`fh-ds-card fh-ds-entity-card${entity.is_exposed ? "" : " fh-ds-card-off"}`}>
                <header className="fh-ds-card-head">
                  <div className="fh-ds-card-icon"><TableIcon size={18} /></div>
                  <div className="fh-ds-grow fh-ds-min0">
                    <div className="fh-ds-card-title" title={entity.display_name || entity.physical_name}>
                      {entity.display_name || entity.physical_name}
                    </div>
                    <div className="fh-data-studio-mono fh-ds-ellipsis" title={entity.physical_path ?? entity.physical_name}>{entity.physical_name}</div>
                  </div>
                  {entity.entity_type && <Badge>{entity.entity_type.toUpperCase()}</Badge>}
                </header>

                <div className="fh-ds-stats">
                  <div className="fh-ds-stat">
                    <span className="fh-ds-stat-value">{formatCount(entity.column_count ?? 0, locale)}</span>
                    <span className="fh-ds-stat-label">{t("dataStudio.statColumns")}</span>
                  </div>
                  <div className="fh-ds-stat">
                    <span className="fh-ds-stat-value">{entity.row_count_est != null ? `~${formatCount(entity.row_count_est, locale)}` : "—"}</span>
                    <span className="fh-ds-stat-label">{t("dataStudio.statRows")}</span>
                  </div>
                  <div className="fh-ds-stat-flags">
                    {!!entity.is_pii && <Badge tone="danger">PII</Badge>}
                    {!!entity.allow_user && <Badge tone="success">{t("dataStudio.badgeUser")}</Badge>}
                  </div>
                </div>

                <div className="fh-ds-fields">
                  <label className="fh-ds-field">
                    <span>{t("dataStudio.colDisplayName")}</span>
                    <Input
                      defaultValue={entity.display_name}
                      onBlur={(e) => e.target.value !== entity.display_name && saveEntity(entity, { display_name: e.target.value })}
                    />
                  </label>
                  <label className="fh-ds-field">
                    <span>{t("dataStudio.colDescription")}</span>
                    <textarea
                      className="fh-ds-textarea"
                      rows={2}
                      defaultValue={entity.description ?? ""}
                      onBlur={(e) => e.target.value !== (entity.description ?? "") && saveEntity(entity, { description: e.target.value || null })}
                    />
                  </label>
                  <label className="fh-ds-field">
                    <span>{t("dataStudio.colSynonyms")}</span>
                    <Input
                      defaultValue={parseJsonArray(entity.synonyms).join(", ")}
                      placeholder={t("dataStudio.synonymsPlaceholder")}
                      onBlur={(e) => saveEntity(entity, { synonyms: JSON.stringify(e.target.value.split(",").map((s) => s.trim()).filter(Boolean)) })}
                    />
                  </label>
                </div>

                <div className="fh-ds-switches">
                  <Switch label={t("dataStudio.colExposed")} checked={!!entity.is_exposed} onChange={(on) => void saveEntity(entity, { is_exposed: on ? 1 : 0 })} />
                  <Switch label={t("dataStudio.colPii")} checked={!!entity.is_pii} onChange={(on) => void saveEntity(entity, { is_pii: on ? 1 : 0 })} />
                  <Switch label={t("dataStudio.colAllowUser")} checked={!!entity.allow_user} onChange={(on) => void setEntityAllowUser(entity, on)} />
                </div>

                <footer className="fh-ds-card-foot">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSelectedEntityId(entity.id);
                      void loadColumns(entity.id);
                    }}
                  >
                    {t("dataStudio.viewColumns")}
                  </Button>
                </footer>
              </article>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Level 0: data sources.
  return (
    <div className="fh-data-studio-admin">
      <div className="fh-ds-page-head">
        <div className="fh-ds-page-icon"><DataSourcesIcon size={20} /></div>
        <div className="fh-ds-grow">
          <h2 className="fh-ds-page-title">{t("dataStudio.sectionDataSources")}</h2>
          <p className="ds-muted fh-ds-page-hint">{t("dataStudio.sourcesHint")}</p>
        </div>
        <Button variant="primary" className="fh-ds-import" onClick={browseDremio} disabled={browsing || syncing}>
          <DataStudioIcon size={16} />
          {browsing ? t("dataStudio.browsing") : t("dataStudio.importFromDremio")}
        </Button>
      </div>

      {browseError && <div className="data-studio-error fh-ds-error">{browseError}</div>}

      {syncSummary && (
        <div className="fh-ds-sync-done" role="status">
          <div className="fh-ds-sync-done-title">
            <CheckIcon size={16} strokeWidth={3} /> {t("dataStudio.syncDoneTitle")}
          </div>
          <div className="fh-ds-sync-stats">
            {[
              [syncSummary.sources ?? 0, t("dataStudio.statSources")],
              [syncSummary.entities_added ?? 0, t("dataStudio.statNewTables")],
              [syncSummary.columns_synced ?? 0, t("dataStudio.statColumns")],
              ...(reindexSummary ? [[reindexSummary.entities ?? 0, t("dataStudio.statIndexed")] as const] : []),
            ].map(([value, label]) => (
              <div key={String(label)} className="fh-ds-stat">
                <span className="fh-ds-stat-value">{formatCount(Number(value), locale)}</span>
                <span className="fh-ds-stat-label">{label}</span>
              </div>
            ))}
          </div>
          <button type="button" className="fh-ds-dismiss" aria-label={t("dsx.cancel")} onClick={() => setSyncSummary(null)}>×</button>
        </div>
      )}

      {browseResults && !datasetSource && (
        <section className="fh-ds-panel">
          <div className="fh-ds-panel-head">
            <div>
              <h3>{t("dataStudio.pickSourcesTitle")}</h3>
              <p className="ds-muted">{t("dataStudio.pickSourcesHint")}</p>
            </div>
            <button type="button" className="fh-ds-close" aria-label={t("dsx.cancel")} title={t("dsx.cancel")} onClick={() => setBrowseResults(null)}>
              <CloseIcon size={16} />
            </button>
          </div>
          {browseResults.length === 0 ? (
            <div className="fh-ds-empty">{t("dataStudio.noDremioSources")}</div>
          ) : (
            <>
              <div className="fh-ds-pick-grid">
                {browseResults.map((source) => (
                  // one card, two ways in: its body ticks the whole source (sync every table of it), the strip at
                  // its foot opens the source's tables to import only some of them
                  <div key={source.name} className={`fh-ds-pick-item${selectedDremioNames.has(source.name) ? " fh-ds-pick-item-on" : ""}`}>
                    <SelectCard
                      selected={selectedDremioNames.has(source.name)}
                      onToggle={() => setSelectedDremioNames((prev) => toggleIn(prev, source.name))}
                    >
                      <span className="fh-ds-pick-name">{source.name}</span>
                      <Badge>{source.type}</Badge>
                    </SelectCard>
                    <button type="button" className="fh-ds-pick-tables" onClick={() => void openDatasets(source.name)}>
                      <TableIcon size={14} />
                      <span>{t("dataStudio.pickTables")}</span>
                      <ChevronRightIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="fh-ds-actionbar">
                <span className="ds-muted">{t("dataStudio.selectedCount", { n: String(selectedDremioNames.size) })}</span>
                <Button variant="primary" onClick={syncSelected} disabled={syncing || selectedDremioNames.size === 0}>
                  {syncing ? t("dataStudio.syncing") : t("dataStudio.syncSelected")}
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {datasetSource && (
        <section className="fh-ds-panel">
          <div className="fh-ds-panel-head">
            <div>
              <h3>{t("dataStudio.tablesOf", { name: datasetSource })}</h3>
              {datasets && <p className="ds-muted">{t("dataStudio.tableCount", { n: String(datasets.length) })}</p>}
            </div>
            <button type="button" className="fh-ds-close" aria-label={t("dsx.cancel")} title={t("dsx.cancel")} onClick={() => setDatasetSource(null)}>
              <CloseIcon size={16} />
            </button>
          </div>
          {datasets === null ? (
            <div className="fh-ds-empty">{t("dataStudio.loadingTables")}</div>
          ) : datasets.length === 0 ? (
            <div className="fh-ds-empty">{t("dataStudio.noTables")}</div>
          ) : (
            <>
              <div className="fh-ds-toolbar">
                <label className="fh-ds-search">
                  <SearchIcon size={14} />
                  <input value={datasetQuery} onChange={(e) => setDatasetQuery(e.target.value)} placeholder={t("dataStudio.searchTables")} />
                </label>
                {/* every table shown (the search narrows it), imported ones too: importing one again re-syncs its
                    columns. Was "not yet imported" only, which selected nothing on a source already imported. */}
                <button
                  type="button"
                  className="fh-ds-chip-btn"
                  disabled={(visibleDatasets ?? []).every((d) => pickedDatasets.has(d.path.join(".")))}
                  onClick={() =>
                    setPickedDatasets((prev) => new Set([...prev, ...(visibleDatasets ?? []).map((d) => d.path.join("."))]))
                  }
                >
                  <CheckIcon size={14} strokeWidth={2.5} />
                  {t("dataStudio.selectAll")}
                </button>
                <button type="button" className="fh-ds-chip-btn" disabled={pickedDatasets.size === 0} onClick={() => setPickedDatasets(new Set())}>
                  <CloseIcon size={14} />
                  {t("dataStudio.clearSelection")}
                </button>
              </div>
              <div className="fh-ds-pick-grid">
                {(visibleDatasets ?? []).map((d) => {
                  const key = d.path.join(".");
                  return (
                    <SelectCard key={key} selected={pickedDatasets.has(key)} onToggle={() => setPickedDatasets((prev) => toggleIn(prev, key))}>
                      <span className="fh-ds-pick-name">{d.name}</span>
                      <span className="fh-data-studio-mono fh-ds-ellipsis">{d.schema_name || "—"}</span>
                      <span className="fh-ds-pick-badges">
                        <Badge>{d.type}</Badge>
                        {d.imported && <Badge tone="success">{t("dataStudio.alreadyImported")}</Badge>}
                      </span>
                    </SelectCard>
                  );
                })}
              </div>
              {visibleDatasets && visibleDatasets.length === 0 && <div className="fh-ds-empty">{t("dataStudio.noMatch")}</div>}
              <div className="fh-ds-actionbar">
                <span className="ds-muted">{t("dataStudio.selectedCount", { n: String(pickedDatasets.size) })}</span>
                <Button variant="primary" onClick={() => void importDatasets()} disabled={syncing || pickedDatasets.size === 0}>
                  {syncing ? t("dataStudio.syncing") : t("dataStudio.importPickedTables", { count: String(pickedDatasets.size) })}
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {sources.length === 0 ? (
        <div className="fh-ds-empty fh-ds-empty-big">
          <DataSourcesIcon size={28} />
          <p>{t("dataStudio.noSources")}</p>
          <Button variant="primary" onClick={browseDremio} disabled={browsing}>
            {t("dataStudio.importFromDremio")}
          </Button>
        </div>
      ) : (
        <div className="fh-ds-source-grid">
          {sources.map((source) => (
            <article key={source.id} className={`fh-ds-card fh-ds-source-card${source.is_exposed_to_agent ? "" : " fh-ds-card-off"}`}>
              <header className="fh-ds-card-head">
                <div className="fh-ds-card-icon"><DataSourcesIcon size={18} /></div>
                <div className="fh-ds-grow fh-ds-min0">
                  <div className="fh-ds-card-title" title={source.name}>{source.name}</div>
                  <div className="fh-data-studio-mono fh-ds-ellipsis" title={source.dremio_path}>{source.dremio_path}</div>
                </div>
                <Badge>{source.source_type}</Badge>
              </header>
              <div className="fh-ds-stats">
                <div className="fh-ds-stat">
                  <span className="fh-ds-stat-value">{formatCount(source.entity_count ?? 0, locale)}</span>
                  <span className="fh-ds-stat-label">{t("dataStudio.statTables")}</span>
                </div>
                <div className="fh-ds-stat">
                  <span className="fh-ds-stat-value fh-ds-stat-small">
                    {source.last_synced_at ? new Date(source.last_synced_at).toLocaleDateString(dateLocale) : "—"}
                  </span>
                  <span className="fh-ds-stat-label">{t("dataStudio.statLastSync")}</span>
                </div>
                <div className="fh-ds-stat-flags">
                  <Badge tone={["connected", "active", "ok"].includes(source.status) ? "success" : "neutral"}>{source.status}</Badge>
                </div>
              </div>
              <div className="fh-ds-switches">
                <Switch
                  label={t("dataStudio.colExposedToAgent")}
                  checked={!!source.is_exposed_to_agent}
                  onChange={() => void toggleSourceExposed(source)}
                />
              </div>
              <footer className="fh-ds-card-foot">
                <Button
                  variant="primary"
                  onClick={() => {
                    setSelectedSourceId(source.id);
                    void loadEntities(source.id);
                  }}
                >
                  {t("dataStudio.viewEntities")}
                </Button>
                <button type="button" className="fh-ds-danger" onClick={() => void deleteSource(source)} title={t("dataStudio.deleteSource")}>
                  <TrashIcon size={14} /> {t("dataStudio.deleteSource")}
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
