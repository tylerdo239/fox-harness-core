// Copied from bot-data-studio-web-main/src/components/profile/json-fields-editor.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Plus, SearchCheck, Trash2 } from "lucide-react";
import { HelpLabel } from "@/components/profile/field-help";
import { ValueCatalogEditor } from "@/components/profile/value-catalog-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { checkJsonField } from "@/lib/api";
import type { JsonField, JsonFieldType } from "@/lib/types";

const TYPES: { value: JsonFieldType; label: string }[] = [
  { value: "BOOLEAN", label: "BOOLEAN — true/false" },
  { value: "VARCHAR", label: "VARCHAR — text" },
  { value: "INTEGER", label: "INTEGER — whole number" },
  { value: "BIGINT", label: "BIGINT — large whole number" },
  { value: "DOUBLE", label: "DOUBLE — decimal number" },
  { value: "DATE", label: "DATE" },
  { value: "TIMESTAMP", label: "TIMESTAMP" },
];

interface Row extends JsonField {
  key: string; // stable React key
}

interface CheckState {
  loading: boolean;
  text?: string;
  error?: string;
  empty?: boolean;
}

function newKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function JsonFieldsEditor({
  entityId,
  columnId,
  columnName,
  fields,
  onChange,
}: {
  entityId: string;
  columnId: string;
  columnName: string;
  fields: JsonField[];
  onChange: (fields: JsonField[]) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => fields.map((f) => ({ ...f, key: newKey() })));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [checks, setChecks] = useState<Record<string, CheckState>>({});

  function update(next: Row[]) {
    setRows(next);
    onChange(
      next
        .filter((r) => r.path.trim())
        .map((r) => ({
          path: r.path.trim(),
          data_type: r.data_type,
          display_name: r.display_name?.trim() || null,
          description: r.description,
          value_catalog: r.value_catalog,
          value_catalog_complete: r.value_catalog_complete,
        })),
    );
  }

  function setRow(key: string, patch: Partial<Row>) {
    update(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    if ("path" in patch || "data_type" in patch) {
      setChecks((prev) => ({ ...prev, [key]: { loading: false } }));
    }
  }

  async function check(row: Row) {
    setChecks((prev) => ({ ...prev, [row.key]: { loading: true } }));
    try {
      const r = await checkJsonField(entityId, columnId, row.path.trim(), row.data_type);
      setChecks((prev) => ({
        ...prev,
        [row.key]: {
          loading: false,
          empty: r.rows_with_value === 0,
          text: `${r.rows_with_value.toLocaleString("vi-VN")} of ${r.total_rows.toLocaleString("vi-VN")} rows have this field`,
        },
      }));
    } catch (err) {
      setChecks((prev) => ({
        ...prev,
        [row.key]: { loading: false, error: err instanceof Error ? err.message : "Check failed" },
      }));
    }
  }

  const duplicates = new Set(
    rows.map((r) => r.path.trim()).filter((p, i, all) => p && all.indexOf(p) !== i),
  );

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => {
        const c = checks[row.key];
        const expanded = !!open[row.key];
        return (
          <div key={row.key} className="flex flex-col gap-2 rounded-md border p-3">
            <div className="grid gap-2 md:grid-cols-[1fr_12rem_1fr_auto]">
              <div className="flex flex-col gap-1">
                <HelpLabel help="json_path" required>
                  Path in {columnName}
                </HelpLabel>
                <Input
                  value={row.path}
                  onChange={(e) => setRow(row.key, { path: e.target.value })}
                  placeholder="is_intent_node"
                  className={`h-8 font-mono text-xs ${duplicates.has(row.path.trim()) ? "border-destructive" : ""}`}
                />
              </div>
              <div className="flex flex-col gap-1">
                <HelpLabel help="json_type" required>
                  Type
                </HelpLabel>
                <Select value={row.data_type} onValueChange={(v) => setRow(row.key, { data_type: v as JsonFieldType })}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Display name</Label>
                <Input
                  value={row.display_name ?? ""}
                  onChange={(e) => setRow(row.key, { display_name: e.target.value })}
                  placeholder="Là intent node"
                  className="h-8 text-xs"
                />
              </div>
              <div className="flex items-end gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => check(row)}
                  disabled={!row.path.trim() || c?.loading}
                  title="Count how many rows have this field (runs one read-only query)"
                >
                  {c?.loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <SearchCheck className="mr-1 h-3.5 w-3.5" />}
                  Check
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => update(rows.filter((r) => r.key !== row.key))}
                  aria-label={`Remove ${row.path || "field"}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {duplicates.has(row.path.trim()) && (
              <p className="text-xs text-destructive">This path is listed twice.</p>
            )}
            {c?.text && (
              <p className={`text-xs ${c.empty ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
                {c.text}
                {c.empty && " — check the spelling (case matters) and the type."}
              </p>
            )}
            {c?.error && <p className="text-xs text-destructive">{c.error}</p>}
            <Input
              value={row.description ?? ""}
              onChange={(e) => setRow(row.key, { description: e.target.value || null })}
              placeholder="Description, e.g. true when the node detects the user's intent"
              className="h-8 text-xs"
            />
            <button
              type="button"
              onClick={() => setOpen((prev) => ({ ...prev, [row.key]: !expanded }))}
              className="flex items-center gap-1 self-start text-xs text-primary hover:underline"
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Values ({row.value_catalog.length})
            </button>
            {expanded && (
              <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-2">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={row.value_catalog_complete}
                    onCheckedChange={(v) => setRow(row.key, { value_catalog_complete: v })}
                    id={`jf_complete_${row.key}`}
                  />
                  <Label htmlFor={`jf_complete_${row.key}`} className="text-xs font-normal">
                    List is complete (filters may only use these values)
                  </Label>
                </div>
                <ValueCatalogEditor
                  key={row.data_type}
                  items={row.value_catalog}
                  onChange={(items) => setRow(row.key, { value_catalog: items })}
                  booleanPreset={row.data_type === "BOOLEAN"}
                />
              </div>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() =>
          update([
            ...rows,
            {
              key: newKey(),
              path: "",
              data_type: "BOOLEAN",
              display_name: null,
              description: null,
              value_catalog: [],
              value_catalog_complete: false,
            },
          ])
        }
      >
        <Plus className="mr-1 h-4 w-4" /> Add JSON field
      </Button>
    </div>
  );
}
