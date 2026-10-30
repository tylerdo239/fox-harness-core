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
import { confirmDialog } from "../../primitives/ConfirmDialog.tsx";
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
    <label className={`fh-ds-switch inline-flex items-center [gap:8px] cursor-pointer select-none [font-size:0.9em] [color:var(--fg)] [&_input]:absolute [&_input]:[opacity:0] [&_input]:[width:1px] [&_input]:[height:1px] [&_input:checked+.fh-ds-switch-track]:[background:var(--accent)] [&_input:checked+.fh-ds-switch-track_.fh-ds-switch-thumb]:[transform:translateX(16px)] [&_input:focus-visible+.fh-ds-switch-track]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_30%,transparent)]${compact ? " fh-ds-switch-compact justify-center" : ""}${disabled ? " fh-ds-switch-disabled [&&]:cursor-not-allowed [opacity:0.45]" : ""}`} title={hint}>
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
      <span className="fh-ds-switch-track relative flex-none [width:36px] [height:20px] [border-radius:999px] [background:var(--border)] [transition:background_160ms_ease] [@media(prefers-reduced-motion:reduce)]:[transition:none] [@media(prefers-reduced-motion:reduce)]:[animation:none]" aria-hidden="true">
        <span className="fh-ds-switch-thumb absolute [top:2px] [left:2px] [width:16px] [height:16px] [border-radius:50%] [background:#fff] [box-shadow:0_1px_3px_rgb(0_0_0_/_0.25)] [transition:transform_160ms_ease] [@media(prefers-reduced-motion:reduce)]:[transition:none] [@media(prefers-reduced-motion:reduce)]:[animation:none]" />
      </span>
      {label && !compact && <span className="fh-ds-switch-label">{label}</span>}
    </label>
  );
}

/** A card the whole of which toggles a selection, with a check mark in its corner. */
function SelectCard({ selected, onToggle, children }: { selected: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`fh-ds-select-card relative flex items-start [gap:10px] w-full [padding:12px] [border:1.5px_solid_var(--border)] [border-radius:12px] [background:var(--bg)] [color:var(--fg)] text-left [font:inherit] cursor-pointer [transition:border-color_120ms_ease,background_120ms_ease,box-shadow_120ms_ease] [&:hover]:[border-color:color-mix(in_srgb,var(--accent)_55%,var(--border))] [&:focus-visible]:[outline:none] [&:focus-visible]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_35%,transparent)] [@media(prefers-reduced-motion:reduce)]:[transition:none] [@media(prefers-reduced-motion:reduce)]:[animation:none] [height:auto]${selected ? " fh-ds-select-card-on [&&&]:[border-color:var(--accent)] [&&]:[background:color-mix(in_srgb,var(--accent)_8%,var(--bg))] [box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_15%,transparent)] [&_.fh-ds-check]:[background:var(--accent)] [&_.fh-ds-check]:[border-color:var(--accent)]" : ""}`} aria-pressed={selected} onClick={onToggle}>
      <span className="fh-ds-check flex-none [width:18px] [height:18px] [margin-top:1px] [border:1.5px_solid_var(--border)] [border-radius:5px] inline-flex items-center justify-center [background:var(--bg)] [color:var(--accent-contrast)] [transition:background_120ms_ease,border-color_120ms_ease]" aria-hidden="true">{selected && <CheckIcon size={12} strokeWidth={3} />}</span>
      <span className="fh-ds-select-card-body flex flex-col [gap:4px] min-w-0 [flex:1] [&_.fh-data-studio-mono]:[font-size:0.8em] [&>.fh-ds-badge]:self-start">{children}</span>
    </button>
  );
}

// one literal per tone, so the Tailwind move can find each class (docs/ui-performance-plan.md §8)
const BADGE_TONE_CLASS = {
  neutral: "fh-ds-badge-neutral",
  accent: "fh-ds-badge-accent [&&]:[background:color-mix(in_srgb,var(--accent)_12%,transparent)] [&&]:[color:var(--accent-text)] [&&]:[border-color:color-mix(in_srgb,var(--accent)_35%,transparent)]",
  success: "fh-ds-badge-success [&&]:[background:color-mix(in_srgb,var(--status-success)_12%,transparent)] [color:var(--status-success)] [&&]:[border-color:color-mix(in_srgb,var(--status-success)_35%,transparent)]",
  muted: "fh-ds-badge-muted [&&]:[background:transparent] [font-family:monospace] [&&]:font-medium",
  danger: "fh-ds-badge-danger [&&]:[background:color-mix(in_srgb,var(--status-danger)_12%,transparent)] [color:var(--status-danger)] [&&]:[border-color:color-mix(in_srgb,var(--status-danger)_35%,transparent)]",
} as const;

function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "success" | "muted" | "danger"; children: ReactNode }) {
  return <span className={`fh-ds-badge inline-flex items-center [height:20px] [padding:0_8px] [border-radius:999px] [font-size:11px] font-semibold [letter-spacing:0.02em] whitespace-nowrap [background:var(--bg-raised)] [color:var(--muted)] [border:1px_solid_var(--border)] ${BADGE_TONE_CLASS[tone]}`}>{children}</span>;
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
    const ok = await confirmDialog({
      title: t("dataStudio.deleteSourceTitle"),
      message: t("dataStudio.deleteSourceConfirm", { name: source.name }),
      confirmLabel: t("dataStudio.deleteSource"),
      danger: true,
    });
    if (!ok) return;
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

  if (loading) return <div className="fh-data-studio-loading [padding:48px] text-center [color:var(--muted)]">{t("dataStudio.loading")}</div>;

  // Level 2: columns of a selected entity.
  if (selectedEntity) {
    return (
      <div className="fh-data-studio-admin">
        <button
          type="button"
          className="fh-data-studio-crumb-back inline-flex items-center [gap:6px] [margin-bottom:16px] p-0 [background:none] [border:none] [color:var(--fg)] [font-size:1.05em] font-medium cursor-pointer [&:hover]:[color:var(--accent)]"
          onClick={() => {
            setSelectedEntityId(null);
            setColumns([]);
          }}
        >
          <ArrowLeftIcon size={14} /> {selectedSource?.name}
        </button>
        <div className="fh-ds-page-head flex items-center [gap:12px] [margin-bottom:18px] flex-wrap">
          <div className="fh-ds-page-icon flex-none [width:40px] [height:40px] [border-radius:12px] inline-flex items-center justify-center [background:color-mix(in_srgb,var(--accent)_14%,transparent)] [color:var(--accent-text)]"><TableIcon size={20} /></div>
          <div>
            <h2 className="fh-ds-page-title m-0 [font-size:1.25em] [font-weight:650]">{selectedEntity.display_name || selectedEntity.physical_name}</h2>
            <div className="fh-ds-page-meta flex items-center [gap:8px] [margin-top:4px] flex-wrap [font-size:0.85em]">
              <span className="fh-data-studio-mono [font-family:monospace] [color:var(--muted)] whitespace-nowrap">{selectedEntity.physical_name}</span>
              <Badge tone="accent">{t("dataStudio.columnCount", { n: String(columns.length) })}</Badge>
            </div>
          </div>
        </div>
        <div className="fh-ds-table-wrap overflow-x-auto [border:1px_solid_var(--border)] [border-radius:12px]">
          <table className="fh-data-studio-table w-full [border-collapse:collapse] [font-size:0.9em] [&_th]:text-left [&_th]:[padding:8px_10px] [&_th]:[border-bottom:1px_solid_var(--border-subtle)] [&_th]:[color:var(--muted)] [&_th]:font-medium [&_th]:whitespace-nowrap [&_td]:[padding:6px_10px] [&_td]:[border-bottom:1px_solid_var(--border-subtle)] [&_td]:[vertical-align:middle] [&_input[type=text]]:w-full [&_input[type=text]]:[min-width:120px] [&_input:not([type])]:w-full [&_input:not([type])]:[min-width:120px] [&_select]:w-full [&_select]:[min-width:120px] fh-ds-columns [&_th]:[background:var(--surface)] [&_td_.fh-ds-badge]:[margin-top:4px] [&_input:not([type=checkbox])]:w-full [&_input:not([type=checkbox])]:[height:34px] [&_input:not([type=checkbox])]:[padding:0_10px] [&_input:not([type=checkbox])]:[border:1px_solid_var(--border)] [&_input:not([type=checkbox])]:[border-radius:var(--radius-md,10px)] [&_input:not([type=checkbox])]:[background:var(--bg)] [&_input:not([type=checkbox])]:[color:var(--fg)] [&_input:not([type=checkbox])]:[font:inherit] [&&_input:not([type=checkbox])]:[font-size:0.92em] [&_input:not([type=checkbox]):focus]:[outline:none] [&_input:not([type=checkbox]):focus]:[border-color:var(--accent)] [&_input:not([type=checkbox]):focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]">
            <thead>
              <tr>
                <th>{t("dataStudio.colPhysical")}</th>
                <th>{t("dataStudio.colDisplayName")}</th>
                <th>{t("dataStudio.colDescription")}</th>
                <th>{t("dataStudio.colRole")}</th>
                <th>{t("dataStudio.colSemanticType")}</th>
                <th>{t("dataStudio.colAggregation")}</th>
                <th className="fh-ds-center text-center">{t("dataStudio.colExposed")}</th>
                <th className="fh-ds-center text-center">{t("dataStudio.colPii")}</th>
                <th className="fh-ds-center text-center">{t("dataStudio.colAllowUser")}</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr key={column.id}>
                  <td>
                    <div className="fh-data-studio-mono [font-family:monospace] whitespace-nowrap fh-ds-strong [color:var(--fg)] font-semibold">{column.physical_name}</div>
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
                    <select className="fh-ds-select [&:focus]:[outline:none] [&:focus]:[border-color:var(--accent)] [&:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] [height:32px] [padding:0_8px] [border:1px_solid_var(--border)] [border-radius:8px] [background:var(--bg)] [color:var(--fg)] [font:inherit] [&&]:[font-size:0.9em]" defaultValue={column.role ?? ""} onChange={(e) => saveColumn(column, { role: e.target.value || null })}>
                      {ROLE_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>{opt || "—"}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select className="fh-ds-select [&:focus]:[outline:none] [&:focus]:[border-color:var(--accent)] [&:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] [height:32px] [padding:0_8px] [border:1px_solid_var(--border)] [border-radius:8px] [background:var(--bg)] [color:var(--fg)] [font:inherit] [&&]:[font-size:0.9em]" defaultValue={column.semantic_type ?? ""} onChange={(e) => saveColumn(column, { semantic_type: e.target.value || null })}>
                      {SEMANTIC_TYPE_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>{opt || "—"}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select className="fh-ds-select [&:focus]:[outline:none] [&:focus]:[border-color:var(--accent)] [&:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] [height:32px] [padding:0_8px] [border:1px_solid_var(--border)] [border-radius:8px] [background:var(--bg)] [color:var(--fg)] [font:inherit] [&&]:[font-size:0.9em]" defaultValue={column.default_aggregation ?? ""} onChange={(e) => saveColumn(column, { default_aggregation: e.target.value || null })}>
                      {AGGREGATION_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>{opt || "—"}</option>
                      ))}
                    </select>
                  </td>
                  <td className="fh-ds-center text-center">
                    <Switch compact label={t("dataStudio.colExposed")} checked={!!column.is_exposed} onChange={(on) => void saveColumn(column, { is_exposed: on ? 1 : 0 })} />
                  </td>
                  <td className="fh-ds-center text-center">
                    <Switch compact label={t("dataStudio.colPii")} checked={!!column.is_pii} onChange={(on) => void saveColumn(column, { is_pii: on ? 1 : 0 })} />
                  </td>
                  <td className="fh-ds-center text-center">
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
                  <td colSpan={9} className="fh-data-studio-empty text-center [color:var(--muted)] ![padding:24px]">{t("dataStudio.noColumns")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="ds-muted [color:var(--muted)] fh-ds-footnote [font-size:0.85em] [margin-top:10px]">{t("dataStudio.piiNeverVisible")}</p>
      </div>
    );
  }

  // Level 1: entities of a selected source, as cards.
  if (selectedSourceId !== null) {
    return (
      <div className="fh-data-studio-admin">
        <button
          type="button"
          className="fh-data-studio-crumb-back inline-flex items-center [gap:6px] [margin-bottom:16px] p-0 [background:none] [border:none] [color:var(--fg)] [font-size:1.05em] font-medium cursor-pointer [&:hover]:[color:var(--accent)]"
          onClick={() => {
            setSelectedSourceId(null);
            setEntities([]);
            setEntityQuery("");
          }}
        >
          <ArrowLeftIcon size={14} /> {t("dataStudio.sectionDataSources")}
        </button>
        <div className="fh-ds-page-head flex items-center [gap:12px] [margin-bottom:18px] flex-wrap">
          <div className="fh-ds-page-icon flex-none [width:40px] [height:40px] [border-radius:12px] inline-flex items-center justify-center [background:color-mix(in_srgb,var(--accent)_14%,transparent)] [color:var(--accent-text)]"><DataSourcesIcon size={20} /></div>
          <div className="fh-ds-grow [flex:1]">
            <h2 className="fh-ds-page-title m-0 [font-size:1.25em] [font-weight:650]">{selectedSource?.name}</h2>
            <div className="fh-ds-page-meta flex items-center [gap:8px] [margin-top:4px] flex-wrap [font-size:0.85em]">
              {selectedSource && <Badge>{selectedSource.source_type}</Badge>}
              <Badge tone="accent">{t("dataStudio.tableCount", { n: String(entities.length) })}</Badge>
              {selectedSource && <span className="fh-data-studio-mono [font-family:monospace] [color:var(--muted)] whitespace-nowrap">{selectedSource.dremio_path}</span>}
            </div>
          </div>
          <label className="fh-ds-search inline-flex items-center [gap:6px] [height:34px] [padding:0_10px] [min-width:220px] [border:1px_solid_var(--border)] [border-radius:999px] [background:var(--bg)] [color:var(--muted)] [&:focus-within]:[border-color:var(--accent)] [&:focus-within]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)] [&_input]:[flex:1] [&_input]:min-w-0 [&_input]:[border:0] [&_input]:[outline:none] [&_input]:[background:transparent] [&_input]:[color:var(--fg)] [&_input]:[font:inherit] [@media(max-width:640px)]:min-w-0 [@media(max-width:640px)]:w-full">
            <SearchIcon size={14} />
            <input value={entityQuery} onChange={(e) => setEntityQuery(e.target.value)} placeholder={t("dataStudio.searchTables")} />
          </label>
        </div>

        {visibleEntities.length === 0 ? (
          <div className="fh-ds-empty [padding:22px] [border:1px_dashed_var(--border)] [border-radius:12px] [color:var(--muted)] text-center">{entities.length === 0 ? t("dataStudio.noEntities") : t("dataStudio.noMatch")}</div>
        ) : (
          <div className="fh-ds-entity-grid grid [gap:14px] [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))] [@media(max-width:640px)]:[grid-template-columns:1fr]">
            {visibleEntities.map((entity) => (
              <article key={entity.id} className={`fh-ds-card flex flex-col [gap:14px] [padding:16px] [border:1px_solid_var(--border)] [border-radius:14px] [background:var(--bg)] [box-shadow:var(--shadow-lv1)] [transition:border-color_140ms_ease,box-shadow_140ms_ease,transform_140ms_ease] [&:hover]:[border-color:color-mix(in_srgb,var(--accent)_45%,var(--border))] [&:hover]:[box-shadow:var(--shadow-lv2)] [@media(prefers-reduced-motion:reduce)]:[transition:none] [@media(prefers-reduced-motion:reduce)]:[animation:none] fh-ds-entity-card${entity.is_exposed ? "" : " fh-ds-card-off [background:var(--surface)] [&_.fh-ds-card-icon]:[background:var(--bg-raised)] [&_.fh-ds-card-icon]:[color:var(--muted)]"}`}>
                <header className="fh-ds-card-head flex items-start [gap:10px] [&_.fh-data-studio-mono]:[font-size:0.8em] [&_.fh-data-studio-mono]:[margin-top:2px]">
                  <div className="fh-ds-card-icon flex-none [width:34px] [height:34px] [border-radius:10px] inline-flex items-center justify-center [background:color-mix(in_srgb,var(--accent)_12%,transparent)] [color:var(--accent-text)]"><TableIcon size={18} /></div>
                  <div className="fh-ds-grow [flex:1] fh-ds-min0 min-w-0">
                    <div className="fh-ds-card-title [font-size:1.05em] [font-weight:650] [color:var(--fg)] overflow-hidden text-ellipsis whitespace-nowrap" title={entity.display_name || entity.physical_name}>
                      {entity.display_name || entity.physical_name}
                    </div>
                    <div className="fh-data-studio-mono [font-family:monospace] [color:var(--muted)] fh-ds-ellipsis whitespace-nowrap overflow-hidden text-ellipsis block" title={entity.physical_path ?? entity.physical_name}>{entity.physical_name}</div>
                  </div>
                  {entity.entity_type && <Badge>{entity.entity_type.toUpperCase()}</Badge>}
                </header>

                <div className="fh-ds-stats flex items-end [gap:22px] [padding:10px_12px] [border-radius:10px] [background:var(--surface)]">
                  <div className="fh-ds-stat flex flex-col [gap:2px]">
                    <span className="fh-ds-stat-value [font-size:1.45em] font-bold [line-height:1.1] [color:var(--fg)] [font-variant-numeric:tabular-nums]">{formatCount(entity.column_count ?? 0, locale)}</span>
                    <span className="fh-ds-stat-label [font-size:0.75em] [color:var(--muted)]">{t("dataStudio.statColumns")}</span>
                  </div>
                  <div className="fh-ds-stat flex flex-col [gap:2px]">
                    <span className="fh-ds-stat-value [font-size:1.45em] font-bold [line-height:1.1] [color:var(--fg)] [font-variant-numeric:tabular-nums]">{entity.row_count_est != null ? `~${formatCount(entity.row_count_est, locale)}` : "—"}</span>
                    <span className="fh-ds-stat-label [font-size:0.75em] [color:var(--muted)]">{t("dataStudio.statRows")}</span>
                  </div>
                  <div className="fh-ds-stat-flags [margin-left:auto] flex [gap:6px] flex-wrap justify-end">
                    {!!entity.is_pii && <Badge tone="danger">PII</Badge>}
                    {!!entity.allow_user && <Badge tone="success">{t("dataStudio.badgeUser")}</Badge>}
                  </div>
                </div>

                <div className="fh-ds-fields flex flex-col [gap:10px]">
                  <label className="fh-ds-field flex flex-col [gap:4px] [&>span]:[font-size:0.78em] [&>span]:font-semibold [&>span]:[color:var(--muted)] [&&_input]:w-full [&_input]:[height:34px] [&_input]:[padding:0_10px] [&_input]:[border:1px_solid_var(--border)] [&_input]:[border-radius:var(--radius-md,10px)] [&_input]:[background:var(--bg)] [&_input]:[color:var(--fg)] [&_input]:[font:inherit] [&&_input]:[font-size:0.92em] [&_input:focus]:[outline:none] [&_input:focus]:[border-color:var(--accent)] [&_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] [&_input::placeholder]:[color:var(--muted)]">
                    <span>{t("dataStudio.colDisplayName")}</span>
                    <Input
                      defaultValue={entity.display_name}
                      onBlur={(e) => e.target.value !== entity.display_name && saveEntity(entity, { display_name: e.target.value })}
                    />
                  </label>
                  <label className="fh-ds-field flex flex-col [gap:4px] [&>span]:[font-size:0.78em] [&>span]:font-semibold [&>span]:[color:var(--muted)] [&&_input]:w-full [&_input]:[height:34px] [&_input]:[padding:0_10px] [&_input]:[border:1px_solid_var(--border)] [&_input]:[border-radius:var(--radius-md,10px)] [&_input]:[background:var(--bg)] [&_input]:[color:var(--fg)] [&_input]:[font:inherit] [&&_input]:[font-size:0.92em] [&_input:focus]:[outline:none] [&_input:focus]:[border-color:var(--accent)] [&_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] [&_input::placeholder]:[color:var(--muted)]">
                    <span>{t("dataStudio.colDescription")}</span>
                    <textarea
                      className="fh-ds-textarea w-full [min-height:52px] [padding:8px_10px] [border:1px_solid_var(--border)] [border-radius:var(--radius-md,10px)] [background:var(--bg)] [color:var(--fg)] [font:inherit] [resize:vertical] [&:focus]:[outline:none] [&:focus]:[border-color:var(--accent)] [&:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] [&&]:[font-size:0.92em] [&::placeholder]:[color:var(--muted)]"
                      rows={2}
                      defaultValue={entity.description ?? ""}
                      onBlur={(e) => e.target.value !== (entity.description ?? "") && saveEntity(entity, { description: e.target.value || null })}
                    />
                  </label>
                  <label className="fh-ds-field flex flex-col [gap:4px] [&>span]:[font-size:0.78em] [&>span]:font-semibold [&>span]:[color:var(--muted)] [&&_input]:w-full [&_input]:[height:34px] [&_input]:[padding:0_10px] [&_input]:[border:1px_solid_var(--border)] [&_input]:[border-radius:var(--radius-md,10px)] [&_input]:[background:var(--bg)] [&_input]:[color:var(--fg)] [&_input]:[font:inherit] [&&_input]:[font-size:0.92em] [&_input:focus]:[outline:none] [&_input:focus]:[border-color:var(--accent)] [&_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] [&_input::placeholder]:[color:var(--muted)]">
                    <span>{t("dataStudio.colSynonyms")}</span>
                    <Input
                      defaultValue={parseJsonArray(entity.synonyms).join(", ")}
                      placeholder={t("dataStudio.synonymsPlaceholder")}
                      onBlur={(e) => saveEntity(entity, { synonyms: JSON.stringify(e.target.value.split(",").map((s) => s.trim()).filter(Boolean)) })}
                    />
                  </label>
                </div>

                <div className="fh-ds-switches flex flex-wrap [gap:10px_18px]">
                  <Switch label={t("dataStudio.colExposed")} checked={!!entity.is_exposed} onChange={(on) => void saveEntity(entity, { is_exposed: on ? 1 : 0 })} />
                  <Switch label={t("dataStudio.colPii")} checked={!!entity.is_pii} onChange={(on) => void saveEntity(entity, { is_pii: on ? 1 : 0 })} />
                  <Switch label={t("dataStudio.colAllowUser")} checked={!!entity.allow_user} onChange={(on) => void setEntityAllowUser(entity, on)} />
                </div>

                <footer className="fh-ds-card-foot flex items-center justify-between [gap:8px] [margin-top:auto] [padding-top:12px] [border-top:1px_solid_var(--border-subtle,var(--border))]">
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
      <div className="fh-ds-page-head flex items-center [gap:12px] [margin-bottom:18px] flex-wrap">
        <div className="fh-ds-page-icon flex-none [width:40px] [height:40px] [border-radius:12px] inline-flex items-center justify-center [background:color-mix(in_srgb,var(--accent)_14%,transparent)] [color:var(--accent-text)]"><DataSourcesIcon size={20} /></div>
        <div className="fh-ds-grow [flex:1]">
          <h2 className="fh-ds-page-title m-0 [font-size:1.25em] [font-weight:650]">{t("dataStudio.sectionDataSources")}</h2>
          <p className="ds-muted [color:var(--muted)] fh-ds-page-hint [font-size:0.9em] [margin:2px_0_0]">{t("dataStudio.sourcesHint")}</p>
        </div>
        <Button variant="primary" className="fh-ds-import" onClick={browseDremio} disabled={browsing || syncing}>
          <DataStudioIcon size={16} />
          {browsing ? t("dataStudio.browsing") : t("dataStudio.importFromDremio")}
        </Button>
      </div>

      {browseError && <div className="data-studio-error [color:var(--muted)] fh-ds-error [margin-bottom:14px]">{browseError}</div>}

      {syncSummary && (
        <div className="fh-ds-sync-done relative [margin-bottom:18px] [padding:14px_16px] [border:1px_solid_color-mix(in_srgb,var(--status-success)_40%,var(--border))] [border-radius:14px] [background:color-mix(in_srgb,var(--status-success)_8%,var(--bg))] [animation:fh-ds-in_180ms_ease-out] [@media(prefers-reduced-motion:reduce)]:[transition:none] [@media(prefers-reduced-motion:reduce)]:[animation:none]" role="status">
          <div className="fh-ds-sync-done-title flex items-center [gap:6px] [margin-bottom:10px] [font-weight:650] [color:var(--status-success)]">
            <CheckIcon size={16} strokeWidth={3} /> {t("dataStudio.syncDoneTitle")}
          </div>
          <div className="fh-ds-sync-stats flex [gap:28px] flex-wrap">
            {[
              [syncSummary.sources ?? 0, t("dataStudio.statSources")],
              [syncSummary.entities_added ?? 0, t("dataStudio.statNewTables")],
              [syncSummary.columns_synced ?? 0, t("dataStudio.statColumns")],
              ...(reindexSummary ? [[reindexSummary.entities ?? 0, t("dataStudio.statIndexed")] as const] : []),
            ].map(([value, label]) => (
              <div key={String(label)} className="fh-ds-stat flex flex-col [gap:2px]">
                <span className="fh-ds-stat-value [font-size:1.45em] font-bold [line-height:1.1] [color:var(--fg)] [font-variant-numeric:tabular-nums]">{formatCount(Number(value), locale)}</span>
                <span className="fh-ds-stat-label [font-size:0.75em] [color:var(--muted)]">{label}</span>
              </div>
            ))}
          </div>
          <button type="button" className="fh-ds-dismiss absolute [top:8px] [right:10px] [border:0] [background:transparent] [color:var(--muted)] [font-size:18px] [line-height:1] cursor-pointer [height:auto]" aria-label={t("dsx.cancel")} onClick={() => setSyncSummary(null)}>×</button>
        </div>
      )}

      {browseResults && !datasetSource && (
        <section className="fh-ds-panel [margin-bottom:18px] [padding:16px] [border:1px_solid_color-mix(in_srgb,var(--accent)_30%,var(--border))] [border-radius:14px] [background:color-mix(in_srgb,var(--accent)_4%,var(--bg))]">
          <div className="fh-ds-panel-head flex items-start justify-between [gap:12px] [margin-bottom:12px] [&_h3]:m-0 [&_h3]:[font-size:1.05em] [&_p]:[margin:2px_0_0] [&_p]:[font-size:0.85em]">
            <div>
              <h3>{t("dataStudio.pickSourcesTitle")}</h3>
              <p className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t("dataStudio.pickSourcesHint")}</p>
            </div>
            <button type="button" className="fh-ds-close flex-none [width:30px] [height:30px] p-0 inline-flex items-center justify-center [border:1px_solid_transparent] [border-radius:999px] [background:transparent] [color:var(--muted)] cursor-pointer [transition:background_120ms_ease,color_120ms_ease] [&:hover]:[background:var(--bg-hover)] [&:hover]:[color:var(--fg)]" aria-label={t("dsx.cancel")} title={t("dsx.cancel")} onClick={() => setBrowseResults(null)}>
              <CloseIcon size={16} />
            </button>
          </div>
          {browseResults.length === 0 ? (
            <div className="fh-ds-empty [padding:22px] [border:1px_dashed_var(--border)] [border-radius:12px] [color:var(--muted)] text-center">{t("dataStudio.noDremioSources")}</div>
          ) : (
            <>
              <div className="fh-ds-pick-grid grid [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))] [gap:10px] [max-height:420px] overflow-y-auto [padding:2px]">
                {browseResults.map((source) => (
                  // one card, two ways in: its body ticks the whole source (sync every table of it), the strip at
                  // its foot opens the source's tables to import only some of them
                  <div key={source.name} className={`fh-ds-pick-item flex flex-col [border:1.5px_solid_var(--border)] [border-radius:12px] [background:var(--bg)] overflow-hidden [transition:border-color_120ms_ease,box-shadow_120ms_ease] [&:hover]:[border-color:color-mix(in_srgb,var(--accent)_55%,var(--border))] [&>.fh-ds-select-card]:[border:0] [&>.fh-ds-select-card]:[border-radius:0] [&>.fh-ds-select-card]:[box-shadow:none] [&>.fh-ds-select-card:hover]:[border:0] [&>.fh-ds-select-card:hover]:[border-radius:0] [&>.fh-ds-select-card:hover]:[box-shadow:none]${selectedDremioNames.has(source.name) ? " fh-ds-pick-item-on [&&&]:[border-color:var(--accent)] [box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_15%,transparent)]" : ""}`}>
                    <SelectCard
                      selected={selectedDremioNames.has(source.name)}
                      onToggle={() => setSelectedDremioNames((prev) => toggleIn(prev, source.name))}
                    >
                      <span className="fh-ds-pick-name font-semibold overflow-hidden text-ellipsis whitespace-nowrap">{source.name}</span>
                      <Badge>{source.type}</Badge>
                    </SelectCard>
                    <button type="button" className="fh-ds-pick-tables flex items-center [gap:6px] w-full [padding:8px_12px] [border:0] [&&]:[border-top:1px_solid_var(--border-subtle,var(--border))] [border-radius:0] [background:var(--surface)] [color:var(--accent-text)] [font:inherit] [&&]:[font-size:0.85em] [&&]:font-semibold text-left cursor-pointer [transition:background_120ms_ease] [&>span]:[flex:1] [&:hover]:[background:color-mix(in_srgb,var(--accent)_10%,var(--surface))] [height:auto]" onClick={() => void openDatasets(source.name)}>
                      <TableIcon size={14} />
                      <span>{t("dataStudio.pickTables")}</span>
                      <ChevronRightIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="fh-ds-actionbar sticky [bottom:0] flex items-center justify-end [gap:12px] [margin-top:12px] [padding-top:12px] [border-top:1px_solid_var(--border-subtle,var(--border))]">
                <span className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t("dataStudio.selectedCount", { n: String(selectedDremioNames.size) })}</span>
                <Button variant="primary" onClick={syncSelected} disabled={syncing || selectedDremioNames.size === 0}>
                  {syncing ? t("dataStudio.syncing") : t("dataStudio.syncSelected")}
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {datasetSource && (
        <section className="fh-ds-panel [margin-bottom:18px] [padding:16px] [border:1px_solid_color-mix(in_srgb,var(--accent)_30%,var(--border))] [border-radius:14px] [background:color-mix(in_srgb,var(--accent)_4%,var(--bg))]">
          <div className="fh-ds-panel-head flex items-start justify-between [gap:12px] [margin-bottom:12px] [&_h3]:m-0 [&_h3]:[font-size:1.05em] [&_p]:[margin:2px_0_0] [&_p]:[font-size:0.85em]">
            <div>
              <h3>{t("dataStudio.tablesOf", { name: datasetSource })}</h3>
              {datasets && <p className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t("dataStudio.tableCount", { n: String(datasets.length) })}</p>}
            </div>
            <button type="button" className="fh-ds-close flex-none [width:30px] [height:30px] p-0 inline-flex items-center justify-center [border:1px_solid_transparent] [border-radius:999px] [background:transparent] [color:var(--muted)] cursor-pointer [transition:background_120ms_ease,color_120ms_ease] [&:hover]:[background:var(--bg-hover)] [&:hover]:[color:var(--fg)]" aria-label={t("dsx.cancel")} title={t("dsx.cancel")} onClick={() => setDatasetSource(null)}>
              <CloseIcon size={16} />
            </button>
          </div>
          {datasets === null ? (
            <div className="fh-ds-empty [padding:22px] [border:1px_dashed_var(--border)] [border-radius:12px] [color:var(--muted)] text-center">{t("dataStudio.loadingTables")}</div>
          ) : datasets.length === 0 ? (
            <div className="fh-ds-empty [padding:22px] [border:1px_dashed_var(--border)] [border-radius:12px] [color:var(--muted)] text-center">{t("dataStudio.noTables")}</div>
          ) : (
            <>
              <div className="fh-ds-toolbar flex items-center [gap:10px] [margin-bottom:10px] flex-wrap">
                <label className="fh-ds-search inline-flex items-center [gap:6px] [height:34px] [padding:0_10px] [min-width:220px] [border:1px_solid_var(--border)] [border-radius:999px] [background:var(--bg)] [color:var(--muted)] [&:focus-within]:[border-color:var(--accent)] [&:focus-within]:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)] [&_input]:[flex:1] [&_input]:min-w-0 [&_input]:[border:0] [&_input]:[outline:none] [&_input]:[background:transparent] [&_input]:[color:var(--fg)] [&_input]:[font:inherit] [@media(max-width:640px)]:min-w-0 [@media(max-width:640px)]:w-full">
                  <SearchIcon size={14} />
                  <input value={datasetQuery} onChange={(e) => setDatasetQuery(e.target.value)} placeholder={t("dataStudio.searchTables")} />
                </label>
                {/* every table shown (the search narrows it), imported ones too: importing one again re-syncs its
                    columns. Was "not yet imported" only, which selected nothing on a source already imported. */}
                <button
                  type="button"
                  className="fh-ds-chip-btn inline-flex items-center [gap:6px] [height:32px] [padding:0_12px] [border:1px_solid_var(--border)] [border-radius:999px] [background:var(--bg)] [color:var(--fg)] [font:inherit] [&&]:[font-size:0.85em] [&&]:font-semibold cursor-pointer [transition:border-color_120ms_ease,background_120ms_ease,color_120ms_ease] [&_svg]:[color:var(--accent-text)] [&:hover:not(:disabled)]:[border-color:var(--accent)] [&:hover:not(:disabled)]:[background:color-mix(in_srgb,var(--accent)_8%,var(--bg))] [&:hover:not(:disabled)]:[color:var(--accent-text)] [&:disabled]:[opacity:0.45] [&:disabled]:cursor-default [&:disabled_svg]:[color:var(--muted)]"
                  disabled={(visibleDatasets ?? []).every((d) => pickedDatasets.has(d.path.join(".")))}
                  onClick={() =>
                    setPickedDatasets((prev) => new Set([...prev, ...(visibleDatasets ?? []).map((d) => d.path.join("."))]))
                  }
                >
                  <CheckIcon size={14} strokeWidth={2.5} />
                  {t("dataStudio.selectAll")}
                </button>
                <button type="button" className="fh-ds-chip-btn inline-flex items-center [gap:6px] [height:32px] [padding:0_12px] [border:1px_solid_var(--border)] [border-radius:999px] [background:var(--bg)] [color:var(--fg)] [font:inherit] [&&]:[font-size:0.85em] [&&]:font-semibold cursor-pointer [transition:border-color_120ms_ease,background_120ms_ease,color_120ms_ease] [&_svg]:[color:var(--accent-text)] [&:hover:not(:disabled)]:[border-color:var(--accent)] [&:hover:not(:disabled)]:[background:color-mix(in_srgb,var(--accent)_8%,var(--bg))] [&:hover:not(:disabled)]:[color:var(--accent-text)] [&:disabled]:[opacity:0.45] [&:disabled]:cursor-default [&:disabled_svg]:[color:var(--muted)]" disabled={pickedDatasets.size === 0} onClick={() => setPickedDatasets(new Set())}>
                  <CloseIcon size={14} />
                  {t("dataStudio.clearSelection")}
                </button>
              </div>
              <div className="fh-ds-pick-grid grid [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))] [gap:10px] [max-height:420px] overflow-y-auto [padding:2px]">
                {(visibleDatasets ?? []).map((d) => {
                  const key = d.path.join(".");
                  return (
                    <SelectCard key={key} selected={pickedDatasets.has(key)} onToggle={() => setPickedDatasets((prev) => toggleIn(prev, key))}>
                      <span className="fh-ds-pick-name font-semibold overflow-hidden text-ellipsis whitespace-nowrap">{d.name}</span>
                      <span className="fh-data-studio-mono [font-family:monospace] [color:var(--muted)] fh-ds-ellipsis whitespace-nowrap overflow-hidden text-ellipsis block">{d.schema_name || "—"}</span>
                      <span className="fh-ds-pick-badges flex [gap:6px] flex-wrap">
                        <Badge>{d.type}</Badge>
                        {d.imported && <Badge tone="success">{t("dataStudio.alreadyImported")}</Badge>}
                      </span>
                    </SelectCard>
                  );
                })}
              </div>
              {visibleDatasets && visibleDatasets.length === 0 && <div className="fh-ds-empty [padding:22px] [border:1px_dashed_var(--border)] [border-radius:12px] [color:var(--muted)] text-center">{t("dataStudio.noMatch")}</div>}
              <div className="fh-ds-actionbar sticky [bottom:0] flex items-center justify-end [gap:12px] [margin-top:12px] [padding-top:12px] [border-top:1px_solid_var(--border-subtle,var(--border))]">
                <span className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t("dataStudio.selectedCount", { n: String(pickedDatasets.size) })}</span>
                <Button variant="primary" onClick={() => void importDatasets()} disabled={syncing || pickedDatasets.size === 0}>
                  {syncing ? t("dataStudio.syncing") : t("dataStudio.importPickedTables", { count: String(pickedDatasets.size) })}
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {sources.length === 0 ? (
        <div className="fh-ds-empty [border:1px_dashed_var(--border)] [border-radius:12px] [color:var(--muted)] text-center fh-ds-empty-big [padding:40px_22px] flex flex-col items-center [gap:10px] [&&_p]:m-0">
          <DataSourcesIcon size={28} />
          <p>{t("dataStudio.noSources")}</p>
          <Button variant="primary" onClick={browseDremio} disabled={browsing}>
            {t("dataStudio.importFromDremio")}
          </Button>
        </div>
      ) : (
        <div className="fh-ds-source-grid grid [gap:14px] [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))] [@media(max-width:640px)]:[grid-template-columns:1fr]">
          {sources.map((source) => (
            <article key={source.id} className={`fh-ds-card flex flex-col [gap:14px] [padding:16px] [border:1px_solid_var(--border)] [border-radius:14px] [background:var(--bg)] [box-shadow:var(--shadow-lv1)] [transition:border-color_140ms_ease,box-shadow_140ms_ease,transform_140ms_ease] [&:hover]:[border-color:color-mix(in_srgb,var(--accent)_45%,var(--border))] [&:hover]:[box-shadow:var(--shadow-lv2)] [@media(prefers-reduced-motion:reduce)]:[transition:none] [@media(prefers-reduced-motion:reduce)]:[animation:none] fh-ds-source-card${source.is_exposed_to_agent ? "" : " fh-ds-card-off [background:var(--surface)] [&_.fh-ds-card-icon]:[background:var(--bg-raised)] [&_.fh-ds-card-icon]:[color:var(--muted)]"}`}>
              <header className="fh-ds-card-head flex items-start [gap:10px] [&_.fh-data-studio-mono]:[font-size:0.8em] [&_.fh-data-studio-mono]:[margin-top:2px]">
                <div className="fh-ds-card-icon flex-none [width:34px] [height:34px] [border-radius:10px] inline-flex items-center justify-center [background:color-mix(in_srgb,var(--accent)_12%,transparent)] [color:var(--accent-text)]"><DataSourcesIcon size={18} /></div>
                <div className="fh-ds-grow [flex:1] fh-ds-min0 min-w-0">
                  <div className="fh-ds-card-title [font-size:1.05em] [font-weight:650] [color:var(--fg)] overflow-hidden text-ellipsis whitespace-nowrap" title={source.name}>{source.name}</div>
                  <div className="fh-data-studio-mono [font-family:monospace] [color:var(--muted)] fh-ds-ellipsis whitespace-nowrap overflow-hidden text-ellipsis block" title={source.dremio_path}>{source.dremio_path}</div>
                </div>
                <Badge>{source.source_type}</Badge>
              </header>
              <div className="fh-ds-stats flex items-end [gap:22px] [padding:10px_12px] [border-radius:10px] [background:var(--surface)]">
                <div className="fh-ds-stat flex flex-col [gap:2px]">
                  <span className="fh-ds-stat-value [font-size:1.45em] font-bold [line-height:1.1] [color:var(--fg)] [font-variant-numeric:tabular-nums]">{formatCount(source.entity_count ?? 0, locale)}</span>
                  <span className="fh-ds-stat-label [font-size:0.75em] [color:var(--muted)]">{t("dataStudio.statTables")}</span>
                </div>
                <div className="fh-ds-stat flex flex-col [gap:2px]">
                  <span className="fh-ds-stat-value [line-height:1.1] [color:var(--fg)] [font-variant-numeric:tabular-nums] fh-ds-stat-small [font-size:1em] font-semibold">
                    {source.last_synced_at ? new Date(source.last_synced_at).toLocaleDateString(dateLocale) : "—"}
                  </span>
                  <span className="fh-ds-stat-label [font-size:0.75em] [color:var(--muted)]">{t("dataStudio.statLastSync")}</span>
                </div>
                <div className="fh-ds-stat-flags [margin-left:auto] flex [gap:6px] flex-wrap justify-end">
                  <Badge tone={["connected", "active", "ok"].includes(source.status) ? "success" : "neutral"}>{source.status}</Badge>
                </div>
              </div>
              <div className="fh-ds-switches flex flex-wrap [gap:10px_18px]">
                <Switch
                  label={t("dataStudio.colExposedToAgent")}
                  checked={!!source.is_exposed_to_agent}
                  onChange={() => void toggleSourceExposed(source)}
                />
              </div>
              <footer className="fh-ds-card-foot flex items-center justify-between [gap:8px] [margin-top:auto] [padding-top:12px] [border-top:1px_solid_var(--border-subtle,var(--border))]">
                <Button
                  variant="primary"
                  onClick={() => {
                    setSelectedSourceId(source.id);
                    void loadEntities(source.id);
                  }}
                >
                  {t("dataStudio.viewEntities")}
                </Button>
                <button type="button" className="fh-ds-danger inline-flex items-center [gap:4px] [padding:4px_8px] [border:0] [border-radius:8px] [background:transparent] [color:var(--muted)] [font:inherit] [&&]:[font-size:0.85em] cursor-pointer [&:hover]:[color:var(--status-danger)] [&:hover]:[background:color-mix(in_srgb,var(--status-danger)_10%,transparent)] [height:auto]" onClick={() => void deleteSource(source)} title={t("dataStudio.deleteSource")}>
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
