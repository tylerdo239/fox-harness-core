// docs/data-studio-admin-ui-plan.md — Metrics section (Phase 3, part 4).
// Depends on entities/columns already synced (Data Sources). Real CRUD
// against services/gateway's /data-studio/metrics +
// /data-studio/browse-entities routes.
import { useCallback, useEffect, useMemo, useState } from "react";

import { TrashIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";
import { Input } from "../../primitives/Input.tsx";

interface BrowseEntity {
  id: number;
  display_name: string;
  columns: { id: number; display_name: string }[];
}

interface Metric {
  id: number;
  name: string;
  description: string | null;
  base_entity_id: number;
  base_entity_name: string;
  aggregation: string;
  measure_column_id: number;
  measure_column_name: string;
  unit: string | null;
  is_verified: 0 | 1;
}

const AGGREGATION_OPTIONS = ["sum", "avg", "count", "count_distinct", "min", "max"];

const EMPTY_DRAFT = { name: "", description: "", baseEntityId: "" as number | "", measureColumnId: "" as number | "", aggregation: AGGREGATION_OPTIONS[0] };

export function DataStudioMetrics() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [entities, setEntities] = useState<BrowseEntity[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [entitiesRes, metricsRes] = await Promise.all([
      runtime.authedFetch("/data-studio/browse-entities"),
      runtime.authedFetch("/data-studio/metrics"),
    ]);
    if (entitiesRes.ok) setEntities(await entitiesRes.json());
    if (metricsRes.ok) setMetrics(await metricsRes.json());
    setLoading(false);
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load]);

  const measureColumns = useMemo(() => entities.find((e) => e.id === draft.baseEntityId)?.columns ?? [], [entities, draft.baseEntityId]);
  const canCreate = draft.name.trim() && draft.baseEntityId !== "" && draft.measureColumnId !== "";

  async function createMetric(): Promise<void> {
    if (!canCreate) return;
    setSaving(true);
    const res = await runtime.authedFetch("/data-studio/metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        base_entity_id: draft.baseEntityId,
        measure_column_id: draft.measureColumnId,
        aggregation: draft.aggregation,
      }),
    });
    setSaving(false);
    if (res.ok) {
      setDraft(EMPTY_DRAFT);
      await load();
    }
  }

  async function toggleVerified(metric: Metric): Promise<void> {
    await runtime.authedFetch(`/data-studio/metrics/${metric.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_verified: !metric.is_verified }),
    });
    await load();
  }

  async function deleteMetric(metric: Metric): Promise<void> {
    const res = await runtime.authedFetch(`/data-studio/metrics/${metric.id}`, { method: "DELETE" });
    if (res.ok) await load();
  }

  if (loading) return <div className="fh-data-studio-loading">{t("dataStudio.loading")}</div>;

  return (
    <div className="fh-data-studio-admin">
      <div className="fh-data-studio-admin-header">
        <h2>{t("dataStudio.sectionMetrics")}</h2>
      </div>

      <div className="fh-data-studio-relationship-form">
        <Input
          placeholder={t("dataStudio.metricNamePlaceholder")}
          value={draft.name}
          onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
        />
        <select
          value={draft.baseEntityId}
          onChange={(e) => setDraft((prev) => ({ ...prev, baseEntityId: e.target.value ? Number(e.target.value) : "", measureColumnId: "" }))}
        >
          <option value="">{t("dataStudio.fromEntity")}</option>
          {entities.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {entity.display_name}
            </option>
          ))}
        </select>
        <select
          value={draft.measureColumnId}
          onChange={(e) => setDraft((prev) => ({ ...prev, measureColumnId: e.target.value ? Number(e.target.value) : "" }))}
          disabled={!measureColumns.length}
        >
          <option value="">{t("dataStudio.measureColumn")}</option>
          {measureColumns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.display_name}
            </option>
          ))}
        </select>
        <select value={draft.aggregation} onChange={(e) => setDraft((prev) => ({ ...prev, aggregation: e.target.value }))}>
          {AGGREGATION_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <Button variant="primary" onClick={createMetric} disabled={!canCreate || saving}>
          {t("dataStudio.addMetric")}
        </Button>
      </div>

      <table className="fh-data-studio-table">
        <thead>
          <tr>
            <th>{t("dataStudio.colName")}</th>
            <th>{t("dataStudio.measureColumn")}</th>
            <th>{t("dataStudio.colAggregation")}</th>
            <th>{t("dataStudio.colVerified")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => (
            <tr key={metric.id}>
              <td>{metric.name}</td>
              <td>
                {metric.base_entity_name}.{metric.measure_column_name}
              </td>
              <td>{metric.aggregation}</td>
              <td>
                <input type="checkbox" checked={!!metric.is_verified} onChange={() => void toggleVerified(metric)} />
              </td>
              <td>
                <IconButton onClick={() => deleteMetric(metric)} title={t("dataStudio.deleteMetric")}>
                  <TrashIcon size={14} />
                </IconButton>
              </td>
            </tr>
          ))}
          {metrics.length === 0 && (
            <tr>
              <td colSpan={5} className="fh-data-studio-empty">
                {t("dataStudio.noMetrics")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
