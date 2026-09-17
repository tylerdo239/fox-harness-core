// docs/data-studio-admin-ui-plan.md — Relationships section (Phase 3, part
// 3). Depends on entities/columns already synced (Data Sources). Real CRUD
// against services/gateway's /data-studio/relationships +
// /data-studio/browse-entities routes.
import { useCallback, useEffect, useMemo, useState } from "react";

import { TrashIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";

interface BrowseEntity {
  id: number;
  display_name: string;
  physical_name: string;
  columns: { id: number; display_name: string; physical_name: string }[];
}

interface Relationship {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  from_entity_name: string;
  to_entity_name: string;
  cardinality: string;
  join_type_default: string;
  column_pairs: { from_column_id: number; to_column_id: number; from_column_name: string; to_column_name: string }[];
}

const CARDINALITY_OPTIONS = ["1:1", "1:N", "N:N"];
const JOIN_TYPE_OPTIONS = ["left", "inner"];

export function DataStudioRelationships() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [entities, setEntities] = useState<BrowseEntity[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [loading, setLoading] = useState(true);
  const [fromEntityId, setFromEntityId] = useState<number | "">("");
  const [toEntityId, setToEntityId] = useState<number | "">("");
  const [fromColumnId, setFromColumnId] = useState<number | "">("");
  const [toColumnId, setToColumnId] = useState<number | "">("");
  const [cardinality, setCardinality] = useState(CARDINALITY_OPTIONS[1]);
  const [joinType, setJoinType] = useState(JOIN_TYPE_OPTIONS[0]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [entitiesRes, relationshipsRes] = await Promise.all([
      runtime.authedFetch("/data-studio/browse-entities"),
      runtime.authedFetch("/data-studio/relationships"),
    ]);
    if (entitiesRes.ok) setEntities(await entitiesRes.json());
    if (relationshipsRes.ok) setRelationships(await relationshipsRes.json());
    setLoading(false);
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load]);

  const fromColumns = useMemo(() => entities.find((e) => e.id === fromEntityId)?.columns ?? [], [entities, fromEntityId]);
  const toColumns = useMemo(() => entities.find((e) => e.id === toEntityId)?.columns ?? [], [entities, toEntityId]);

  const canCreate = fromEntityId !== "" && toEntityId !== "" && fromColumnId !== "" && toColumnId !== "";

  async function createRelationship(): Promise<void> {
    if (!canCreate) return;
    setSaving(true);
    const res = await runtime.authedFetch("/data-studio/relationships", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from_entity_id: fromEntityId,
        to_entity_id: toEntityId,
        cardinality,
        join_type_default: joinType,
        column_pairs: [{ from_column_id: fromColumnId, to_column_id: toColumnId }],
      }),
    });
    setSaving(false);
    if (res.ok) {
      setFromEntityId("");
      setToEntityId("");
      setFromColumnId("");
      setToColumnId("");
      await load();
    }
  }

  async function deleteRelationship(relationship: Relationship): Promise<void> {
    const res = await runtime.authedFetch(`/data-studio/relationships/${relationship.id}`, { method: "DELETE" });
    if (res.ok) await load();
  }

  if (loading) return <div className="fh-data-studio-loading">{t("dataStudio.loading")}</div>;

  return (
    <div className="fh-data-studio-admin">
      <div className="fh-data-studio-admin-header">
        <h2>{t("dataStudio.sectionRelationships")}</h2>
      </div>

      <div className="fh-data-studio-relationship-form">
        <select value={fromEntityId} onChange={(e) => { setFromEntityId(e.target.value ? Number(e.target.value) : ""); setFromColumnId(""); }}>
          <option value="">{t("dataStudio.fromEntity")}</option>
          {entities.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {entity.display_name}
            </option>
          ))}
        </select>
        <select value={fromColumnId} onChange={(e) => setFromColumnId(e.target.value ? Number(e.target.value) : "")} disabled={!fromColumns.length}>
          <option value="">{t("dataStudio.fromColumn")}</option>
          {fromColumns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.display_name}
            </option>
          ))}
        </select>
        <span className="fh-data-studio-relationship-arrow">→</span>
        <select value={toEntityId} onChange={(e) => { setToEntityId(e.target.value ? Number(e.target.value) : ""); setToColumnId(""); }}>
          <option value="">{t("dataStudio.toEntity")}</option>
          {entities.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {entity.display_name}
            </option>
          ))}
        </select>
        <select value={toColumnId} onChange={(e) => setToColumnId(e.target.value ? Number(e.target.value) : "")} disabled={!toColumns.length}>
          <option value="">{t("dataStudio.toColumn")}</option>
          {toColumns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.display_name}
            </option>
          ))}
        </select>
        <select value={cardinality} onChange={(e) => setCardinality(e.target.value)}>
          {CARDINALITY_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <select value={joinType} onChange={(e) => setJoinType(e.target.value)}>
          {JOIN_TYPE_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <Button variant="primary" onClick={createRelationship} disabled={!canCreate || saving}>
          {t("dataStudio.addRelationship")}
        </Button>
      </div>

      <table className="fh-data-studio-table">
        <thead>
          <tr>
            <th>{t("dataStudio.colFrom")}</th>
            <th>{t("dataStudio.colTo")}</th>
            <th>{t("dataStudio.colCardinality")}</th>
            <th>{t("dataStudio.colJoinType")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {relationships.map((rel) => (
            <tr key={rel.id}>
              <td>
                {rel.from_entity_name}.{rel.column_pairs[0]?.from_column_name}
              </td>
              <td>
                {rel.to_entity_name}.{rel.column_pairs[0]?.to_column_name}
              </td>
              <td>{rel.cardinality}</td>
              <td>{rel.join_type_default}</td>
              <td>
                <IconButton onClick={() => deleteRelationship(rel)} title={t("dataStudio.deleteRelationship")}>
                  <TrashIcon size={14} />
                </IconButton>
              </td>
            </tr>
          ))}
          {relationships.length === 0 && (
            <tr>
              <td colSpan={5} className="fh-data-studio-empty">
                {t("dataStudio.noRelationships")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
