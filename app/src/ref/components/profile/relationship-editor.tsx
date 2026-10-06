// Copied from bot-data-studio-web-main/src/components/profile/relationship-editor.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  Database,
  Eye,
  KeyRound,
  Loader2,
  Plus,
  Table2,
  Trash2,
  TriangleAlert,
  Wand2,
} from "lucide-react";
import { FieldHelp, RequiredMark } from "@/components/profile/field-help";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createRelationshipItem,
  getProfileTables,
  getTableColumnOptions,
  updateRelationshipItem,
} from "@/lib/api";
import type {
  Cardinality,
  ColumnOption,
  JoinType,
  RelationshipItem,
  TableOption,
} from "@/lib/types";
import type { ProfileHelpKey } from "@/lib/profile-help";

const ALL = "__all__";

// same grouping as the backend warning (src/data_profile/relationships.py)
const TYPE_FAMILY: Record<string, string> = {
  VARCHAR: "text",
  CHAR: "text",
  STRING: "text",
  INTEGER: "number",
  INT: "number",
  BIGINT: "number",
  SMALLINT: "number",
  TINYINT: "number",
  DECIMAL: "number",
  DOUBLE: "number",
  FLOAT: "number",
  NUMERIC: "number",
  DATE: "date",
  TIMESTAMP: "timestamp",
  TIMESTAMPTZ: "timestamp",
  TIME: "time",
  BOOLEAN: "boolean",
};
function family(type: string): string {
  return TYPE_FAMILY[type.toUpperCase()] ?? type.toLowerCase();
}

function singular(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith("ies")) return `${n.slice(0, -3)}y`;
  if (n.endsWith("s")) return n.slice(0, -1);
  return n;
}

interface PairDraft {
  from: string;
  to: string;
}

// ── table picker ──

/** The path below the data source (the list is already grouped by source). */
function pathInSource(t: TableOption): string {
  const prefix = `${t.data_source_name}.`;
  return t.physical_path.startsWith(prefix)
    ? t.physical_path.slice(prefix.length)
    : t.physical_path;
}

export function TablePicker({
  tables,
  value,
  onChange,
  label,
  help,
}: {
  tables: TableOption[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  help: ProfileHelpKey;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState(ALL);
  const [editing, setEditing] = useState(!value);
  const selected = tables.find((t) => t.entity_id === value);
  const sources = useMemo(
    () => [
      ...new Map(
        tables.map((t) => [t.data_source_id, t.data_source_name]),
      ).entries(),
    ],
    [tables],
  );

  const q = query.trim().toLowerCase();
  const shown = tables.filter(
    (t) =>
      (source === ALL || t.data_source_id === source) &&
      (!q ||
        t.display_name.toLowerCase().includes(q) ||
        t.physical_path.toLowerCase().includes(q)),
  );
  const groups = new Map<string, TableOption[]>();
  for (const t of shown.slice(0, 200)) {
    groups.set(t.data_source_name, [
      ...(groups.get(t.data_source_name) ?? []),
      t,
    ]);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-1.5">
        <Label>
          {label}
          <RequiredMark />
        </Label>
        <FieldHelp id={help} />
      </span>
      {selected && !editing ? (
        <div className="flex items-start justify-between gap-2 rounded-md border px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database className="h-3 w-3" /> {selected.data_source_name}
            </div>
            <div
              className="break-all font-mono text-sm font-semibold text-primary"
              title={selected.physical_path}
            >
              {selected.physical_path}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {selected.display_name}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
          >
            Change
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border p-2">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tables"
              className="h-8 text-sm"
              autoFocus
            />
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All sources</SelectItem>
                {sources.map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {groups.size === 0 && (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                No tables match.
              </p>
            )}
            {[...groups.entries()].map(([sourceName, items]) => (
              <div key={sourceName} className="mb-1">
                <div className="sticky top-0 flex items-center gap-1.5 bg-card px-2 py-1 text-xs font-medium text-muted-foreground">
                  <Database className="h-3 w-3" /> {sourceName}
                </div>
                {items.map((t) => (
                  <button
                    key={t.entity_id}
                    type="button"
                    onClick={() => {
                      onChange(t.entity_id);
                      setEditing(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${
                      t.entity_id === value ? "bg-accent" : ""
                    }`}
                  >
                    {t.entity_type === "table" ? (
                      <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span
                        className="truncate font-mono text-[13px] font-semibold text-primary"
                        title={t.physical_path}
                      >
                        {pathInSource(t)}
                      </span>
                      {t.display_name !== t.physical_name && (
                        <span className="truncate text-xs text-muted-foreground">
                          {t.display_name}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {shown.length > 200 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                Showing 200 of {shown.length}. Type to narrow down.
              </p>
            )}
          </div>
          {selected && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-end"
              onClick={() => setEditing(false)}
            >
              Keep {selected.physical_name}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ColumnSelect({
  columns,
  value,
  onChange,
  placeholder,
}: {
  columns: ColumnOption[] | undefined;
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
}) {
  return (
    <Select
      value={value || undefined}
      onValueChange={onChange}
      disabled={!columns}
    >
      <SelectTrigger className="h-9 min-w-0 flex-1 text-xs">
        <SelectValue
          placeholder={columns ? placeholder : "Pick the table first"}
        />
      </SelectTrigger>
      <SelectContent>
        {columns?.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <span className="font-mono">{c.physical_name}</span>
            <span className="text-muted-foreground">
              {" "}
              · {c.data_type}
              {c.role ? ` · ${c.role}` : ""}
              {c.is_grain_key ? " · identifies a row" : ""}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── dialog ──

export function RelationshipEditor({
  relationship,
  trigger,
  onSaved,
}: {
  relationship?: RelationshipItem;
  trigger: ReactNode;
  onSaved: (item: RelationshipItem) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        {open && (
          <EditorForm
            relationship={relationship}
            onCancel={() => setOpen(false)}
            onSaved={(item) => {
              onSaved(item);
              setOpen(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditorForm({
  relationship,
  onCancel,
  onSaved,
}: {
  relationship?: RelationshipItem;
  onCancel: () => void;
  onSaved: (item: RelationshipItem) => void;
}) {
  const [tables, setTables] = useState<TableOption[] | null>(null);
  const [columns, setColumns] = useState<Record<string, ColumnOption[]>>({});
  const [fromId, setFromId] = useState(
    relationship?.from_table.entity_id ?? "",
  );
  const [toId, setToId] = useState(relationship?.to_table.entity_id ?? "");
  const [cardinality, setCardinality] = useState<Cardinality>(
    relationship?.cardinality ?? "1:N",
  );
  const [joinType, setJoinType] = useState<JoinType>(
    relationship?.join_type_default ?? "left",
  );
  const [pairs, setPairs] = useState<PairDraft[]>(
    relationship?.pairs.map((p) => ({
      from: p.from_column_id,
      to: p.to_column_id,
    })) ?? [{ from: "", to: "" }],
  );
  const p = relationship?.profile;
  const [matchRate, setMatchRate] = useState(
    p?.match_rate == null ? "" : String(Math.round(p.match_rate * 1000) / 10),
  );
  const [fanout, setFanout] = useState(
    p?.fanout_ratio == null ? "" : String(p.fanout_ratio),
  );
  const [notes, setNotes] = useState(p?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    getProfileTables()
      .then(setTables)
      .catch((err) =>
        setErrors([
          err instanceof Error ? err.message : "Failed to load tables",
        ]),
      );
  }, []);

  // load a table's columns once, when it is picked
  useEffect(() => {
    for (const id of [fromId, toId]) {
      if (id && !(id in columns)) {
        getTableColumnOptions(id)
          .then((cols) => setColumns((prev) => ({ ...prev, [id]: cols })))
          .catch((err) =>
            setErrors([
              err instanceof Error ? err.message : "Failed to load columns",
            ]),
          );
      }
    }
  }, [fromId, toId, columns]);

  const fromTable = tables?.find((t) => t.entity_id === fromId);
  const toTable = tables?.find((t) => t.entity_id === toId);
  const fromCols = fromId ? columns[fromId] : undefined;
  const toCols = toId ? columns[toId] : undefined;
  const crossSource =
    !!fromTable &&
    !!toTable &&
    fromTable.data_source_id !== toTable.data_source_id;
  const fromName = fromTable?.physical_name ?? "From";
  const toName = toTable?.physical_name ?? "To";

  function setPair(i: number, patch: Partial<PairDraft>) {
    setPairs((prev) => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  function swapSides() {
    setFromId(toId);
    setToId(fromId);
    setPairs((prev) => prev.map((x) => ({ from: x.to, to: x.from })));
  }

  /** Match columns with the same name, or `<to table>_id` to the To table's row key. */
  function suggestKeys() {
    if (!fromCols || !toCols || !toTable) return;
    const found: PairDraft[] = [];
    const toByName = new Map(
      toCols.map((c) => [c.physical_name.toLowerCase(), c]),
    );
    const toKey = toCols.find((c) => c.is_grain_key) ?? toByName.get("id");
    for (const c of fromCols) {
      const name = c.physical_name.toLowerCase();
      const same = toByName.get(name);
      const looksLikeKey =
        c.role === "key" || name === "id" || name.endsWith("_id");
      if (same && looksLikeKey) found.push({ from: c.id, to: same.id });
      else if (toKey && name === `${singular(toTable.physical_name)}_id`)
        found.push({ from: c.id, to: toKey.id });
    }
    if (found.length === 0) {
      setErrors(["No matching key columns found by name. Pick them by hand."]);
      return;
    }
    setErrors([]);
    setPairs(found);
  }

  const pairWarnings = pairs.flatMap((pr) => {
    const a = fromCols?.find((c) => c.id === pr.from);
    const b = toCols?.find((c) => c.id === pr.to);
    if (!a || !b) return [];
    const fa = family(a.data_type);
    const fb = family(b.data_type);
    if (fa === fb) return [];
    return [
      `${a.physical_name} (${a.data_type}) = ${b.physical_name} (${b.data_type}): ${
        [fa, fb].includes("text") && [fa, fb].includes("number")
          ? "text vs number — check the values match exactly (leading zeros, spaces)"
          : "different types — the join may fail or match nothing"
      }`,
    ];
  });

  function num(text: string): number | null {
    if (!text.trim()) return null;
    const n = Number(text.replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  }

  async function handleSave() {
    const errs: string[] = [];
    if (!fromId || !toId) errs.push("Pick both tables");
    const complete = pairs.filter((x) => x.from && x.to);
    if (complete.length === 0)
      errs.push("Pick at least one pair of key columns");
    const rate = num(matchRate);
    const ratio = num(fanout);
    if (Number.isNaN(rate) || Number.isNaN(ratio))
      errs.push("Match rate and fan-out must be numbers");
    if (errs.length) {
      setErrors(errs);
      return;
    }
    setSaving(true);
    setErrors([]);
    const input = {
      from_entity_id: fromId,
      to_entity_id: toId,
      cardinality,
      join_type_default: joinType,
      pairs: complete.map((x) => ({
        from_column_id: x.from,
        to_column_id: x.to,
      })),
      profile: {
        match_rate: rate === null ? null : rate / 100,
        fanout_ratio: ratio,
        notes: notes.trim() || null,
      },
    };
    try {
      onSaved(
        relationship
          ? await updateRelationshipItem(relationship.id, input)
          : await createRelationshipItem(input),
      );
    } catch (err) {
      setErrors(
        (err instanceof Error ? err.message : "Failed to save").split("\n"),
      );
    } finally {
      setSaving(false);
    }
  }

  const CARDINALITY: { value: Cardinality; label: string }[] = [
    {
      value: "1:N",
      label: `1 → many: one ${fromName} row matches many ${toName} rows`,
    },
    {
      value: "1:1",
      label: `1 → 1: one ${fromName} row matches at most one ${toName} row`,
    },
    { value: "N:N", label: `many → many: rows on both sides repeat` },
  ];
  const JOINS: { value: JoinType; label: string }[] = [
    { value: "left", label: `left — keep ${fromName} rows that have no match` },
    { value: "inner", label: "inner — only rows that match on both sides" },
  ];

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {relationship ? "Edit relationship" : "New relationship"}
        </DialogTitle>
        <DialogDescription>
          How two tables join. The tables can be in different data sources.
        </DialogDescription>
      </DialogHeader>

      {!tables ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex flex-col gap-5 py-2">
          <div className="grid items-start gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <TablePicker
              tables={tables}
              value={fromId}
              onChange={setFromId}
              label="From table"
              help="rel_from_table"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mt-7 self-start justify-self-center"
              onClick={swapSides}
              disabled={!fromId && !toId}
              aria-label="Swap the two tables"
              title="Swap the two tables"
            >
              <ArrowLeftRight className="h-4 w-4" />
            </Button>
            <TablePicker
              tables={tables}
              value={toId}
              onChange={setToId}
              label="To table"
              help="rel_to_table"
            />
          </div>

          {crossSource && (
            <div className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p>
                These tables are in different sources (
                {fromTable?.data_source_name} and {toTable?.data_source_name}).
                Dremio can join them, but only if the key values are written the
                same way in both systems: same type, same upper/lower case, same
                leading zeros. Check a few values before saving, and fill in the
                match rate if you know it.
              </p>
            </div>
          )}

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <KeyRound className="h-4 w-4" /> Key columns
                <RequiredMark />
                <FieldHelp id="rel_keys" />
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={suggestKeys}
                disabled={!fromCols || !toCols}
                title="Match columns with the same name, or <table>_id to the other table's key"
              >
                <Wand2 className="mr-1 h-4 w-4" /> Suggest keys
              </Button>
            </div>
            {pairs.map((pr, i) => (
              <div key={i} className="flex items-center gap-2">
                <ColumnSelect
                  columns={fromCols}
                  value={pr.from}
                  onChange={(v) => setPair(i, { from: v })}
                  placeholder={`${fromName} column`}
                />
                <span className="text-muted-foreground">=</span>
                <ColumnSelect
                  columns={toCols}
                  value={pr.to}
                  onChange={(v) => setPair(i, { to: v })}
                  placeholder={`${toName} column`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setPairs((prev) => prev.filter((_, j) => j !== i))
                  }
                  disabled={pairs.length === 1}
                  aria-label="Remove this pair"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() =>
                setPairs((prev) => [...prev, { from: "", to: "" }])
              }
            >
              <Plus className="mr-1 h-4 w-4" /> Add a pair (for keys made of
              several columns)
            </Button>
            {pairWarnings.map((w) => (
              <p
                key={w}
                className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400"
              >
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
              </p>
            ))}
          </section>

          <section className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <Label>
                  How many rows match
                  <RequiredMark />
                </Label>
                <FieldHelp id="cardinality" />
              </span>
              <Select
                value={cardinality}
                onValueChange={(v) => setCardinality(v as Cardinality)}
              >
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CARDINALITY.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                E.g. one agent has many conversations: From = Agent, To =
                Conversation, 1 → many.
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <Label>
                  Default join
                  <RequiredMark />
                </Label>
                <FieldHelp id="join_type" />
              </span>
              <Select
                value={joinType}
                onValueChange={(v) => setJoinType(v as JoinType)}
              >
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {JOINS.map((j) => (
                    <SelectItem key={j.value} value={j.value}>
                      {j.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                Unsure? Keep left: nothing is dropped silently.
              </span>
            </div>
          </section>

          <section className="grid gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <Label htmlFor="re_match">Match rate (%)</Label>
                <FieldHelp id="match_rate" />
              </span>
              <Input
                id="re_match"
                value={matchRate}
                onChange={(e) => setMatchRate(e.target.value)}
                placeholder="optional, e.g. 97.8"
                inputMode="decimal"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <Label htmlFor="re_fanout">Fan-out</Label>
                <FieldHelp id="fanout" />
              </span>
              <Input
                id="re_fanout"
                value={fanout}
                onChange={(e) => setFanout(e.target.value)}
                placeholder="optional, e.g. 2.7"
                inputMode="decimal"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <Label htmlFor="re_notes">Notes</Label>
                <FieldHelp id="relationship_notes" />
              </span>
              <Textarea
                id="re_notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={1}
                className="min-h-9"
              />
            </div>
          </section>

          {errors.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-destructive">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving || !tables}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {relationship ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function SourceBadge({ name }: { name: string }) {
  return (
    <Badge variant="outline" className="gap-1 font-normal">
      <Database className="h-3 w-3" /> {name}
    </Badge>
  );
}
