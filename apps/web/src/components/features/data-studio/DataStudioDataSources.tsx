// docs/data-studio-admin-ui-plan.md — Data Sources section (Phase 3, part 1).
// 3-level drill-down (sources -> entities -> columns), same "local state
// swaps the view" pattern ProjectHub.tsx already uses instead of adding more
// URL routes for this. Real CRUD against services/gateway's new
// /data-studio/* routes (data-studio-db.ts) — no mock data.
import { useCallback, useEffect, useState } from "react";

import { ArrowLeftIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { Input } from "../../primitives/Input.tsx";

// Real field shapes — services/gateway/src/data-studio-db.ts's row types,
// mirrored here (JSON over the wire, so `synonyms`/etc. arrive as strings).
interface DataSource {
  id: number;
  name: string;
  source_type: string;
  dremio_path: string;
  status: string;
  is_exposed_to_agent: 0 | 1;
}
interface Entity {
  id: number;
  data_source_id: number;
  physical_name: string;
  display_name: string;
  description: string | null;
  synonyms: string;
  grain_description: string | null;
  is_exposed: 0 | 1;
  is_pii: 0 | 1;
}
interface EntityColumn {
  id: number;
  entity_id: number;
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
}

const ROLE_OPTIONS = ["", "dimension", "measure", "key"];
const SEMANTIC_TYPE_OPTIONS = ["", "currency", "date", "datetime", "category", "id", "percent", "count", "text", "pii", "boolean"];
const AGGREGATION_OPTIONS = ["", "sum", "avg", "count", "count_distinct", "min", "max"];

function parseJsonArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function DataStudioDataSources() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [sources, setSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<number | null>(null);
  const [columns, setColumns] = useState<EntityColumn[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [browseResults, setBrowseResults] = useState<{ name: string; type: string }[] | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [selectedDremioNames, setSelectedDremioNames] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<Record<string, number> | null>(null);
  const [reindexSummary, setReindexSummary] = useState<Record<string, number> | null>(null);

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
    async (sourceId: number) => {
      const res = await runtime.authedFetch(`/data-studio/sources/${sourceId}/entities`);
      if (res.ok) setEntities(await res.json());
    },
    [runtime],
  );

  const loadColumns = useCallback(
    async (entityId: number) => {
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

  const selectedEntity = entities.find((e) => e.id === selectedEntityId) ?? null;

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
          <ArrowLeftIcon size={14} /> {selectedEntity.display_name || selectedEntity.physical_name}
        </button>
        <table className="fh-data-studio-table">
          <thead>
            <tr>
              <th>{t("dataStudio.colPhysical")}</th>
              <th>{t("dataStudio.colDisplayName")}</th>
              <th>{t("dataStudio.colDescription")}</th>
              <th>{t("dataStudio.colRole")}</th>
              <th>{t("dataStudio.colSemanticType")}</th>
              <th>{t("dataStudio.colAggregation")}</th>
              <th>{t("dataStudio.colExposed")}</th>
              <th>{t("dataStudio.colPii")}</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.id}>
                <td className="fh-data-studio-mono">{column.physical_name}</td>
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
                  <select
                    defaultValue={column.role ?? ""}
                    onChange={(e) => saveColumn(column, { role: e.target.value || null })}
                  >
                    {ROLE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt || "—"}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    defaultValue={column.semantic_type ?? ""}
                    onChange={(e) => saveColumn(column, { semantic_type: e.target.value || null })}
                  >
                    {SEMANTIC_TYPE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt || "—"}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    defaultValue={column.default_aggregation ?? ""}
                    onChange={(e) => saveColumn(column, { default_aggregation: e.target.value || null })}
                  >
                    {AGGREGATION_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt || "—"}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    defaultChecked={!!column.is_exposed}
                    onChange={(e) => saveColumn(column, { is_exposed: e.target.checked ? 1 : 0 })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    defaultChecked={!!column.is_pii}
                    onChange={(e) => saveColumn(column, { is_pii: e.target.checked ? 1 : 0 })}
                  />
                </td>
              </tr>
            ))}
            {columns.length === 0 && (
              <tr>
                <td colSpan={8} className="fh-data-studio-empty">
                  {t("dataStudio.noColumns")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  // Level 1: entities of a selected source.
  if (selectedSourceId !== null) {
    return (
      <div className="fh-data-studio-admin">
        <button
          type="button"
          className="fh-data-studio-crumb-back"
          onClick={() => {
            setSelectedSourceId(null);
            setEntities([]);
          }}
        >
          <ArrowLeftIcon size={14} /> {sources.find((s) => s.id === selectedSourceId)?.name}
        </button>
        <table className="fh-data-studio-table">
          <thead>
            <tr>
              <th>{t("dataStudio.colPhysical")}</th>
              <th>{t("dataStudio.colDisplayName")}</th>
              <th>{t("dataStudio.colDescription")}</th>
              <th>{t("dataStudio.colSynonyms")}</th>
              <th>{t("dataStudio.colExposed")}</th>
              <th>{t("dataStudio.colPii")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entities.map((entity) => (
              <tr key={entity.id}>
                <td className="fh-data-studio-mono">{entity.physical_name}</td>
                <td>
                  <Input
                    defaultValue={entity.display_name}
                    onBlur={(e) => e.target.value !== entity.display_name && saveEntity(entity, { display_name: e.target.value })}
                  />
                </td>
                <td>
                  <Input
                    defaultValue={entity.description ?? ""}
                    onBlur={(e) => e.target.value !== (entity.description ?? "") && saveEntity(entity, { description: e.target.value || null })}
                  />
                </td>
                <td>
                  <Input
                    defaultValue={parseJsonArray(entity.synonyms).join(", ")}
                    placeholder={t("dataStudio.synonymsPlaceholder")}
                    onBlur={(e) => saveEntity(entity, { synonyms: JSON.stringify(e.target.value.split(",").map((s) => s.trim()).filter(Boolean)) })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    defaultChecked={!!entity.is_exposed}
                    onChange={(e) => saveEntity(entity, { is_exposed: e.target.checked ? 1 : 0 })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    defaultChecked={!!entity.is_pii}
                    onChange={(e) => saveEntity(entity, { is_pii: e.target.checked ? 1 : 0 })}
                  />
                </td>
                <td>
                  <Button
                    variant="link"
                    onClick={() => {
                      setSelectedEntityId(entity.id);
                      void loadColumns(entity.id);
                    }}
                  >
                    {t("dataStudio.viewColumns")}
                  </Button>
                </td>
              </tr>
            ))}
            {entities.length === 0 && (
              <tr>
                <td colSpan={7} className="fh-data-studio-empty">
                  {t("dataStudio.noEntities")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  // Level 0: data sources.
  return (
    <div className="fh-data-studio-admin">
      <div className="fh-data-studio-admin-header fh-data-studio-admin-header-row">
        <h2>{t("dataStudio.sectionDataSources")}</h2>
        <Button variant="outline" onClick={browseDremio} disabled={browsing}>
          {t("dataStudio.importFromDremio")}
        </Button>
      </div>

      {browseError && <div className="data-studio-error">{browseError}</div>}
      {syncSummary && (
        <div className="fh-data-studio-sync-summary">
          {t("dataStudio.syncSummary", {
            sources: String(syncSummary.sources ?? 0),
            entities: String(syncSummary.entities_added ?? 0),
            columns: String(syncSummary.columns_synced ?? 0),
          })}
          {reindexSummary && (
            <>
              {" "}
              {t("dataStudio.reindexSummary", { entities: String(reindexSummary.entities ?? 0) })}
            </>
          )}
        </div>
      )}

      {browseResults && (
        <div className="fh-data-studio-dremio-browse">
          {browseResults.length === 0 ? (
            <p className="fh-data-studio-empty">{t("dataStudio.noDremioSources")}</p>
          ) : (
            <>
              <ul className="fh-data-studio-dremio-list">
                {browseResults.map((source) => (
                  <li key={source.name}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedDremioNames.has(source.name)}
                        onChange={(e) =>
                          setSelectedDremioNames((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(source.name);
                            else next.delete(source.name);
                            return next;
                          })
                        }
                      />
                      {source.name} <span className="fh-data-studio-mono">({source.type})</span>
                    </label>
                  </li>
                ))}
              </ul>
              <Button variant="primary" onClick={syncSelected} disabled={syncing || selectedDremioNames.size === 0}>
                {syncing ? t("dataStudio.syncing") : t("dataStudio.syncSelected")}
              </Button>
            </>
          )}
        </div>
      )}

      <table className="fh-data-studio-table">
        <thead>
          <tr>
            <th>{t("dataStudio.colName")}</th>
            <th>{t("dataStudio.colType")}</th>
            <th>{t("dataStudio.colDremioPath")}</th>
            <th>{t("dataStudio.colStatus")}</th>
            <th>{t("dataStudio.colExposedToAgent")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.id}>
              <td>{source.name}</td>
              <td>{source.source_type}</td>
              <td className="fh-data-studio-mono">{source.dremio_path}</td>
              <td>{source.status}</td>
              <td>
                <input
                  type="checkbox"
                  defaultChecked={!!source.is_exposed_to_agent}
                  onChange={() => void toggleSourceExposed(source)}
                />
              </td>
              <td>
                <Button
                  variant="link"
                  onClick={() => {
                    setSelectedSourceId(source.id);
                    void loadEntities(source.id);
                  }}
                >
                  {t("dataStudio.viewEntities")}
                </Button>
              </td>
            </tr>
          ))}
          {sources.length === 0 && (
            <tr>
              <td colSpan={6} className="fh-data-studio-empty">
                {t("dataStudio.noSources")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
