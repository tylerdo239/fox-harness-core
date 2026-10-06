// Copied from bot-data-studio-web-main/src/components/profile/filter-editor.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { FieldHelp } from "@/components/profile/field-help";
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
import type { FilterOp, ProfileColumn, TypedFilter } from "@/lib/types";

const OPS: { value: FilterOp; label: string }[] = [
  { value: "=", label: "=" },
  { value: "!=", label: "≠" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
  { value: ">", label: ">" },
  { value: ">=", label: "≥" },
  { value: "<", label: "<" },
  { value: "<=", label: "≤" },
  { value: "is_null", label: "is empty" },
  { value: "is_not_null", label: "is not empty" },
];
const NO_VALUE: FilterOp[] = ["is_null", "is_not_null"];
const MULTI: FilterOp[] = ["in", "not_in"];

interface Row {
  column_id: string;
  op: FilterOp;
  values: string[];
  text: string; // free-text values for columns without a value list
  reason: string;
}

function toRow(f: TypedFilter): Row {
  const values = f.values.map(String);
  return {
    column_id: f.column_id,
    op: f.op,
    values,
    text: values.join(", "),
    reason: f.reason ?? "",
  };
}

// columns that mark a row as deleted/removed: a filter on them is easy to get backwards
const DELETION_COLUMN = /(^|[._])(deleted|removed|archived|is_deleted|is_removed|is_archived)(_at|_on|_date|_time)?$/i;

function opText(op: FilterOp): string {
  return OPS.find((o) => o.value === op)?.label ?? op;
}

/** Plain-language reading of one filter, and a warning when it likely keeps the wrong rows. */
function explain(row: Row, col: ProfileColumn | undefined): { text: string; warning: string | null } | null {
  if (!col || !row.column_id) return null;
  const name = col.physical_name;
  const values = NO_VALUE.includes(row.op)
    ? []
    : hasCatalog(col)
      ? row.values
      : row.text.split(",").map((v) => v.trim()).filter(Boolean);
  if (!NO_VALUE.includes(row.op) && values.length === 0) return null;
  const valueText = values.join(", ");
  const text = NO_VALUE.includes(row.op)
    ? `Keeps rows where ${name} ${row.op === "is_null" ? "has no value" : "has a value"}`
    : `Keeps rows where ${name} ${opText(row.op)} ${valueText}`;

  let warning: string | null = null;
  if (DELETION_COLUMN.test(name)) {
    const truthy = ["true", "1", "yes"];
    const keepsDeleted =
      row.op === "is_not_null" ||
      (row.op === "=" && values.some((v) => truthy.includes(String(v).toLowerCase())));
    if (keepsDeleted) {
      warning = `This keeps only the DELETED rows. To exclude deleted rows, use ${
        row.op === "is_not_null" ? `“${name} is empty”` : `“${name} = false”`
      }.`;
    }
  }
  return { text: row.op === "is_null" && DELETION_COLUMN.test(name) ? `${text} — rows that are not deleted` : text, warning };
}

const BOOLEAN_CHOICES = [
  { value: "true", label: "True", synonyms: [], count: null },
  { value: "false", label: "False", synonyms: [], count: null },
];

/** Values to pick from: the column's value list, or True/False for a boolean column without one. */
function choicesOf(col: ProfileColumn | undefined) {
  if (!col) return [];
  if (col.profile.value_catalog.length > 0) return col.profile.value_catalog;
  const isBoolean = col.data_type.toUpperCase() === "BOOLEAN" || col.semantic_type === "boolean";
  return isBoolean ? BOOLEAN_CHOICES : [];
}

function hasCatalog(col: ProfileColumn | undefined): boolean {
  return choicesOf(col).length > 0;
}

export function FilterEditor({
  filters,
  columns,
  onChange,
}: {
  filters: TypedFilter[];
  columns: ProfileColumn[];
  onChange: (filters: TypedFilter[]) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => filters.map(toRow));
  const byId = new Map(columns.map((c) => [c.id, c]));

  function emit(next: Row[]) {
    setRows(next);
    onChange(
      next
        .filter((r) => r.column_id)
        .map((r) => {
          const values = NO_VALUE.includes(r.op)
            ? []
            : hasCatalog(byId.get(r.column_id))
              ? r.values
              : r.text
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean);
          return {
            column_id: r.column_id,
            op: r.op,
            values: MULTI.includes(r.op) ? values : values.slice(0, 1),
            reason: r.reason.trim() || null,
          };
        }),
    );
  }

  function setRow(index: number, patch: Partial<Row>) {
    emit(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            Column <FieldHelp id="filter_column" />
          </span>
          <span className="flex items-center gap-1">
            Operator <FieldHelp id="filter_op" />
          </span>
          <span className="flex items-center gap-1">
            Value <FieldHelp id="filter_value" />
          </span>
          <span className="flex items-center gap-1">
            Why <FieldHelp id="filter_reason" />
          </span>
        </div>
      )}
      {rows.map((row, i) => {
        const col = byId.get(row.column_id);
        const catalog = choicesOf(col);
        const multi = MULTI.includes(row.op);
        return (
          <div key={i} className="flex flex-col gap-2 rounded-md border p-2">
            <div className="grid grid-cols-[1fr_7rem_2rem] gap-2">
              <Select
                value={row.column_id || undefined}
                onValueChange={(v) =>
                  setRow(i, { column_id: v, values: [], text: "" })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Column" />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.physical_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={row.op}
                onValueChange={(v) =>
                  setRow(i, {
                    op: v as FilterOp,
                    values: row.values.slice(
                      0,
                      MULTI.includes(v as FilterOp) ? undefined : 1,
                    ),
                  })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => emit(rows.filter((_, j) => j !== i))}
                aria-label="Remove filter"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            {row.column_id &&
              !NO_VALUE.includes(row.op) &&
              (catalog.length > 0 ? (
                multi ? (
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {catalog.map((item) => (
                      <label
                        key={item.value}
                        className="flex items-center gap-1.5 text-xs"
                      >
                        <Checkbox
                          checked={row.values.includes(item.value)}
                          onCheckedChange={(checked) =>
                            setRow(i, {
                              values: checked
                                ? [...row.values, item.value]
                                : row.values.filter((v) => v !== item.value),
                            })
                          }
                        />
                        <span className="font-mono">{item.value}</span>
                        {item.label && (
                          <span className="text-muted-foreground">
                            {item.label}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                ) : (
                  <Select
                    value={row.values[0] ?? undefined}
                    onValueChange={(v) => setRow(i, { values: [v] })}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Value" />
                    </SelectTrigger>
                    <SelectContent>
                      {catalog.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.value}
                          {item.label ? ` — ${item.label}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )
              ) : (
                <Input
                  value={row.text}
                  onChange={(e) => setRow(i, { text: e.target.value })}
                  placeholder={multi ? "value1, value2" : "value"}
                  className="h-8 font-mono text-xs"
                />
              ))}

            {(() => {
              const e = explain(row, col);
              if (!e) return null;
              return (
                <div className="flex flex-col gap-0.5 text-xs">
                  <span className="text-muted-foreground">{e.text}.</span>
                  {e.warning && (
                    <span className="font-medium text-amber-700 dark:text-amber-400">⚠ {e.warning}</span>
                  )}
                </div>
              );
            })()}

            <Input
              value={row.reason}
              onChange={(e) => setRow(i, { reason: e.target.value })}
              placeholder="Why (e.g. only completed orders count as revenue)"
              className="h-8 text-xs"
            />
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            emit([
              ...rows,
              { column_id: "", op: "=", values: [], text: "", reason: "" },
            ])
          }
        >
          <Plus className="mr-1 h-4 w-4" />
          Add filter
        </Button>
      </div>
    </div>
  );
}
