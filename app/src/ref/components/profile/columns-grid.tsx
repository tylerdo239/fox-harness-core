// Copied from bot-data-studio-web-main/src/components/profile/columns-grid.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useMemo, useState } from "react";
import { Loader2, SlidersHorizontal } from "lucide-react";
import { ColumnProfileDialog } from "@/components/profile/column-profile-dialog";
import { FieldHelp, RequiredMark } from "@/components/profile/field-help";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { updateColumnProfiles } from "@/lib/api";
import { useUnsavedWarning } from "@/lib/use-unsaved-warning";
import type {
  Additive,
  ChecklistItem,
  ColumnRole,
  DefaultAggregation,
  EntityProfileDetail,
  ProfileColumn,
  SemanticType,
} from "@/lib/types";

const NONE = "__none__";
const ROLES: ColumnRole[] = ["key", "dimension", "measure"];
const SEMANTIC_TYPES: SemanticType[] = [
  "category",
  "text",
  "id",
  "number",
  "date",
  "datetime",
  "currency",
  "count",
  "percent",
  "boolean",
  "pii",
];
const AGGREGATIONS: DefaultAggregation[] = [
  "sum",
  "avg",
  "count",
  "count_distinct",
  "min",
  "max",
];
const ADDITIVE: { value: Additive; label: string }[] = [
  { value: "all", label: "yes" },
  { value: "not_time", label: "not across time" },
  { value: "none", label: "never" },
];

type View = "all" | "missing" | "unsaved";

export interface OpenColumn {
  id: string;
  order: string[];
}

function MiniSelect<T extends string>({
  value,
  options,
  onChange,
  width = "w-32",
  labels,
}: {
  value: T | null;
  options: readonly T[];
  onChange: (value: T | null) => void;
  width?: string;
  labels?: Partial<Record<T, string>>;
}) {
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : (v as T))}
    >
      <SelectTrigger className={`h-8 ${width} text-xs`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>—</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {labels?.[o] ?? o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function toUpdate(c: ProfileColumn) {
  return {
    id: c.id,
    display_name: c.display_name.trim() || c.physical_name,
    description: c.description,
    synonyms: c.synonyms,
    role: c.role,
    semantic_type: c.semantic_type,
    default_aggregation: c.role === "measure" ? c.default_aggregation : null,
    is_exposed: c.is_exposed,
    is_pii: c.is_pii,
    profile: c.profile,
  };
}

export function ColumnsGrid({
  entityId,
  columns,
  missing,
  open,
  onOpen,
  onSaved,
}: {
  entityId: string;
  columns: ProfileColumn[];
  missing: ChecklistItem[];
  open: OpenColumn | null;
  onOpen: (open: OpenColumn | null) => void;
  onSaved: (detail: EntityProfileDetail) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, ProfileColumn>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirtyCount = Object.keys(drafts).length;
  useUnsavedWarning(dirtyCount > 0);

  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const missingRequired = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of missing) {
      if (m.scope === "column" && m.level === "required") {
        counts.set(m.target_id, (counts.get(m.target_id) ?? 0) + 1);
      }
    }
    return counts;
  }, [missing]);

  const rows = columns.map((c) => drafts[c.id] ?? c);
  const visible = rows.filter((c) => {
    const q = query.trim().toLowerCase();
    if (
      q &&
      !c.physical_name.toLowerCase().includes(q) &&
      !c.display_name.toLowerCase().includes(q)
    ) {
      return false;
    }
    if (view === "missing") return (missingRequired.get(c.id) ?? 0) > 0;
    if (view === "unsaved") return c.id in drafts;
    return true;
  });

  function patch(ids: string[], change: (c: ProfileColumn) => ProfileColumn) {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        const original = byId.get(id);
        if (!original) continue;
        const updated = change(next[id] ?? original);
        if (JSON.stringify(updated) === JSON.stringify(original))
          delete next[id];
        else next[id] = updated;
      }
      return next;
    });
  }

  function setField<K extends keyof ProfileColumn>(
    id: string,
    key: K,
    value: ProfileColumn[K],
  ) {
    patch([id], (c) => ({ ...c, [key]: value }));
  }

  function setProfileField<K extends keyof ProfileColumn["profile"]>(
    id: string,
    key: K,
    value: ProfileColumn["profile"][K],
  ) {
    patch([id], (c) => ({ ...c, profile: { ...c.profile, [key]: value } }));
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const allVisibleSelected =
    visible.length > 0 && visible.every((c) => selected.has(c.id));

  async function saveAll() {
    setSaving(true);
    setError(null);
    try {
      const detail = await updateColumnProfiles(
        entityId,
        Object.values(drafts).map(toUpdate),
      );
      setDrafts({});
      onSaved(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save columns");
    } finally {
      setSaving(false);
    }
  }

  const openColumn = open ? (drafts[open.id] ?? byId.get(open.id)) : undefined;
  const openIndex = open ? open.order.indexOf(open.id) : -1;
  const bulkIds = [...selected];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search columns"
          className="h-8 max-w-xs text-sm"
        />
        {(
          [
            ["all", `All (${columns.length})`],
            ["missing", `Missing required (${missingRequired.size})`],
            ["unsaved", `Unsaved (${dirtyCount})`],
          ] as [View, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setView(value)}
            className={`rounded-full border px-3 py-1 text-xs ${
              view === value
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:bg-accent"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <span className="font-medium">
            {selected.size} selected — set for all:
          </span>
          <MiniSelect<ColumnRole>
            value={null}
            options={ROLES}
            onChange={(v) => patch(bulkIds, (c) => ({ ...c, role: v }))}
            width="w-28"
            labels={{
              key: "role: key",
              dimension: "role: dimension",
              measure: "role: measure",
            }}
          />
          <MiniSelect<SemanticType>
            value={null}
            options={SEMANTIC_TYPES}
            onChange={(v) =>
              patch(bulkIds, (c) => ({ ...c, semantic_type: v }))
            }
            width="w-32"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => patch(bulkIds, (c) => ({ ...c, is_exposed: false }))}
          >
            Hide
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => patch(bulkIds, (c) => ({ ...c, is_exposed: true }))}
          >
            Show
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => patch(bulkIds, (c) => ({ ...c, is_pii: true }))}
          >
            Mark PII
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-2">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={(checked) =>
                    setSelected(
                      checked ? new Set(visible.map((c) => c.id)) : new Set(),
                    )
                  }
                  aria-label="Select all shown columns"
                />
              </th>
              <th className="px-2 py-2">Column</th>
              <th className="px-2 py-2">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  Display name <FieldHelp id="column_display_name" />
                </span>
              </th>
              <th className="px-2 py-2">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  Role
                  <RequiredMark />
                  <FieldHelp id="role" />
                </span>
              </th>
              <th className="px-2 py-2">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  Semantic type
                  <RequiredMark />
                  <FieldHelp id="semantic_type" />
                </span>
              </th>
              <th className="px-2 py-2">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  Aggregation
                  <RequiredMark />
                  <FieldHelp id="aggregation" />
                </span>
              </th>
              <th className="px-2 py-2">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  Unit
                  <RequiredMark />
                  <FieldHelp id="unit" />
                </span>
              </th>
              <th className="px-2 py-2">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  Summable
                  <RequiredMark />
                  <FieldHelp id="additive" />
                </span>
              </th>
              <th className="px-2 py-2">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  Values <FieldHelp id="values" />
                </span>
              </th>
              <th className="px-2 py-2">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  Visible <FieldHelp id="column_visible" />
                </span>
              </th>
              <th className="px-2 py-2">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  PII <FieldHelp id="pii" />
                </span>
              </th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => {
              const dirty = c.id in drafts;
              const isMeasure = c.role === "measure";
              const needsValues =
                c.semantic_type === "category" || c.semantic_type === "boolean";
              const nValues = c.profile.value_catalog.length;
              const nMissing = missingRequired.get(c.id) ?? 0;
              return (
                <tr
                  key={c.id}
                  className={`border-t align-middle ${dirty ? "bg-amber-500/10" : ""} ${c.is_exposed ? "" : "opacity-60"}`}
                >
                  <td className="px-2 py-1.5">
                    <Checkbox
                      checked={selected.has(c.id)}
                      onCheckedChange={(checked) =>
                        toggleSelected(c.id, checked === true)
                      }
                      aria-label={`Select ${c.physical_name}`}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="font-mono text-xs font-semibold">
                      {c.physical_name}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {c.data_type}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      value={
                        c.display_name === c.physical_name ? "" : c.display_name
                      }
                      onChange={(e) =>
                        setField(
                          c.id,
                          "display_name",
                          e.target.value || c.physical_name,
                        )
                      }
                      placeholder={c.physical_name}
                      className="h-8 w-40 text-xs"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <MiniSelect<ColumnRole>
                      value={c.role}
                      options={ROLES}
                      onChange={(v) => setField(c.id, "role", v)}
                      width="w-28"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <MiniSelect<SemanticType>
                      value={c.semantic_type}
                      options={SEMANTIC_TYPES}
                      onChange={(v) => setField(c.id, "semantic_type", v)}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    {isMeasure ? (
                      <MiniSelect<DefaultAggregation>
                        value={c.default_aggregation}
                        options={AGGREGATIONS}
                        onChange={(v) =>
                          setField(c.id, "default_aggregation", v)
                        }
                        width="w-28"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {isMeasure ? (
                      <Input
                        value={c.profile.unit ?? ""}
                        onChange={(e) =>
                          setProfileField(c.id, "unit", e.target.value || null)
                        }
                        placeholder="VND"
                        className="h-8 w-20 text-xs"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {isMeasure ? (
                      <MiniSelect<Additive>
                        value={c.profile.additive}
                        options={ADDITIVE.map((a) => a.value)}
                        labels={Object.fromEntries(
                          ADDITIVE.map((a) => [a.value, a.label]),
                        )}
                        onChange={(v) => setProfileField(c.id, "additive", v)}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {needsValues || nValues > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          onOpen({ id: c.id, order: visible.map((v) => v.id) })
                        }
                        className={`whitespace-nowrap text-xs underline-offset-2 hover:underline ${
                          needsValues && nValues === 0
                            ? "font-medium text-destructive"
                            : "text-primary"
                        }`}
                      >
                        {nValues === 0
                          ? "Add values"
                          : `${nValues} values${c.profile.value_catalog_complete ? "" : " (partial)"}`}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <Switch
                      checked={c.is_exposed}
                      onCheckedChange={(v) => setField(c.id, "is_exposed", v)}
                      aria-label={`${c.physical_name} visible to the agent`}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Switch
                      checked={c.is_pii}
                      onCheckedChange={(v) => setField(c.id, "is_pii", v)}
                      aria-label={`${c.physical_name} is personal data`}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    {dirty ? (
                      <Badge
                        variant="outline"
                        className="border-amber-500 text-amber-700 dark:text-amber-400"
                      >
                        unsaved
                      </Badge>
                    ) : !c.is_exposed ? (
                      <Badge variant="outline">hidden</Badge>
                    ) : nMissing > 0 ? (
                      <Badge variant="destructive">{nMissing} missing</Badge>
                    ) : (
                      <Badge variant="secondary">ok</Badge>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() =>
                        onOpen({ id: c.id, order: visible.map((v) => v.id) })
                      }
                      aria-label={`All fields of ${c.physical_name}`}
                      title="All fields: description, synonyms, values, empty value, format…"
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={13}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  No columns match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {error && (
        <p className="whitespace-pre-line text-sm text-destructive">{error}</p>
      )}

      {dirtyCount > 0 && (
        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 rounded-md border bg-card px-4 py-3 shadow-sm">
          <span className="mr-auto text-sm">
            {dirtyCount} column{dirtyCount > 1 ? "s" : ""} changed, not saved
            yet
          </span>
          <Button
            variant="ghost"
            onClick={() => setDrafts({})}
            disabled={saving}
          >
            Discard
          </Button>
          <Button onClick={saveAll} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save {dirtyCount} column{dirtyCount > 1 ? "s" : ""}
          </Button>
        </div>
      )}

      {open && openColumn && (
        <ColumnProfileDialog
          entityId={entityId}
          column={openColumn}
          columns={columns}
          open
          onOpenChange={(o) => !o && onOpen(null)}
          position={
            openIndex >= 0
              ? { index: openIndex, total: open.order.length }
              : undefined
          }
          onNavigate={
            openIndex >= 0
              ? (dir) => {
                  const nextId = open.order[openIndex + dir];
                  if (nextId) onOpen({ id: nextId, order: open.order });
                }
              : undefined
          }
          onSaved={(detail) => {
            setDrafts((prev) => {
              const next = { ...prev };
              delete next[open.id];
              return next;
            });
            onSaved(detail);
          }}
        />
      )}
    </div>
  );
}
