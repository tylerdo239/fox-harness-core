// Copied from bot-data-studio-web-main/src/components/profile/metric-editor.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useEffect, useState, type ReactNode } from "react";
import {
  CircleCheck,
  Loader2,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  SuggestButton,
  SuggestNote,
  useFieldSuggestion,
} from "@/components/profile/ai-suggest";
import { FieldHelp, HelpLabel } from "@/components/profile/field-help";
import { FilterEditor } from "@/components/profile/filter-editor";
import { TablePicker } from "@/components/profile/relationship-editor";
import { SqlPreview } from "@/components/profile/sql-preview";
import { withJsonFields } from "@/lib/json-fields";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  createProfileMetric,
  getEntityProfile,
  getProfileTables,
  runProfileMetric,
  suggestMetricCalculation,
  suggestMetricField,
  updateProfileMetric,
} from "@/lib/api";
import type {
  Additive,
  DefaultAggregation,
  EntityProfileDetail,
  MetricInput,
  MetricItem,
  MetricKind,
  MetricRunResult,
  TableOption,
  TypedFilter,
} from "@/lib/types";

const NONE = "__none__";
const AGGREGATIONS: { value: DefaultAggregation; label: string }[] = [
  { value: "sum", label: "sum — add up" },
  { value: "count", label: "count — count rows" },
  { value: "count_distinct", label: "count_distinct — count different values" },
  { value: "avg", label: "avg — average" },
  { value: "min", label: "min — smallest" },
  { value: "max", label: "max — largest" },
];
const NON_ADDITIVE: DefaultAggregation[] = [
  "avg",
  "min",
  "max",
  "count_distinct",
];
const NUMERIC = [
  "INTEGER",
  "INT",
  "BIGINT",
  "SMALLINT",
  "TINYINT",
  "DECIMAL",
  "DOUBLE",
  "FLOAT",
  "NUMERIC",
];
const ADDITIVE: { value: Additive; label: string }[] = [
  { value: "all", label: "yes — totals add up, also across time" },
  { value: "not_time", label: "not across time — e.g. stock, balance" },
  { value: "none", label: "never — averages, ratios, distinct counts" },
];

/** "Doanh thu thuần" → "doanh_thu_thuan" */
function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "m_$1")
    .slice(0, 63);
}

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "deleted_at is empty", "status = DONE", "channel in APP, WEB" */
function filterText(column: string, f: TypedFilter): string {
  if (f.op === "is_null") return `${column} is empty`;
  if (f.op === "is_not_null") return `${column} is not empty`;
  const op = f.op === "not_in" ? "not in" : f.op === "!=" ? "≠" : f.op;
  return `${column} ${op} ${f.values.join(", ")}`;
}

function formatNumber(value: number | null, decimals: number | null): string {
  if (value === null) return "empty";
  return value.toLocaleString("vi-VN", {
    maximumFractionDigits: decimals ?? (Number.isInteger(value) ? 0 : 2),
    minimumFractionDigits: decimals ?? 0,
  });
}

interface RefRow {
  period: string;
  value: string;
  source: string;
}

export function MetricEditor({
  metric,
  metrics,
  trigger,
  onSaved,
}: {
  metric?: MetricItem;
  /** all metrics, for picking a ratio's numerator and denominator */
  metrics: MetricItem[];
  trigger: ReactNode;
  onSaved: (item: MetricItem) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        {open && (
          <MetricForm
            metric={metric}
            metrics={metrics}
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function MetricForm({
  metric,
  metrics,
  onCancel,
  onSaved,
}: {
  metric?: MetricItem;
  metrics: MetricItem[];
  onCancel: () => void;
  onSaved: (item: MetricItem) => void;
}) {
  const [tables, setTables] = useState<TableOption[] | null>(null);
  const [table, setTable] = useState<EntityProfileDetail | null>(null);

  const [displayName, setDisplayName] = useState(metric?.display_name ?? "");
  const [name, setName] = useState(metric?.name ?? "");
  const [nameTouched, setNameTouched] = useState(!!metric);
  const [description, setDescription] = useState(metric?.description ?? "");
  const [synonyms, setSynonyms] = useState(metric?.synonyms.join(", ") ?? "");
  const [kind, setKind] = useState<MetricKind>(metric?.kind ?? "aggregate");

  const [entityId, setEntityId] = useState(metric?.entity_id ?? "");
  const [aggregation, setAggregation] = useState<string>(
    metric?.aggregation ?? NONE,
  );
  const [columnId, setColumnId] = useState<string>(metric?.column_id ?? NONE);
  const [filters, setFilters] = useState<TypedFilter[]>(metric?.filters ?? []);
  const [useDefaults, setUseDefaults] = useState(
    metric?.use_table_default_filters ?? true,
  );
  const [timeColumnId, setTimeColumnId] = useState<string>(
    metric?.time_column_id ?? NONE,
  );

  const [numeratorId, setNumeratorId] = useState<string>(
    metric?.numerator_metric_id ?? NONE,
  );
  const [denominatorId, setDenominatorId] = useState<string>(
    metric?.denominator_metric_id ?? NONE,
  );
  const [scale, setScale] = useState(String(metric?.ratio_scale ?? 1));

  const [unit, setUnit] = useState(metric?.unit ?? "");
  const [additive, setAdditive] = useState<string>(metric?.additive ?? NONE);
  const [decimals, setDecimals] = useState(
    metric?.decimals == null ? "" : String(metric.decimals),
  );
  const [direction, setDirection] = useState<string>(
    metric?.good_direction ?? NONE,
  );
  const [examples, setExamples] = useState(
    metric?.example_questions.join("\n") ?? "",
  );
  const [refs, setRefs] = useState<RefRow[]>(
    metric?.reference_values.map((r) => ({
      period: r.period,
      value: String(r.value),
      source: r.source ?? "",
    })) ?? [],
  );
  const [notes, setNotes] = useState(metric?.notes ?? "");

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

  // the chosen table's columns, value lists, time column and default filters
  useEffect(() => {
    if (!entityId) return;
    getEntityProfile(entityId)
      .then(setTable)
      .catch((err) =>
        setErrors([
          err instanceof Error ? err.message : "Failed to load the table",
        ]),
      );
  }, [entityId]);

  // real columns plus declared JSON fields (config.is_intent_node…)
  const columns = table && table.entity.id === entityId ? withJsonFields(table.columns) : [];
  const columnName = (id: string | null | undefined) =>
    columns.find((c) => c.id === id)?.physical_name ?? "?";
  const tableTimeColumn = table?.profile.time_column_id
    ? columnName(table.profile.time_column_id)
    : null;
  const tableDefaults = (table?.profile.default_filters ?? []).map((f) =>
    filterText(columnName(f.column_id), f),
  );
  const forcedNone =
    kind === "ratio" ||
    (aggregation !== NONE &&
      NON_ADDITIVE.includes(aggregation as DefaultAggregation));
  const ratioOptions = metrics.filter((m) => m.id !== metric?.id);
  const isSnapshot = table?.profile.table_kind === "snapshot";

  // the form as it is now (the metric may not be saved yet), sent with every AI suggestion
  const draft = () => ({
    name,
    display_name: displayName,
    description,
    synonyms: splitList(synonyms),
    example_questions: examples
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean),
    kind,
    entity_id: entityId || null,
    aggregation: aggregation === NONE ? null : aggregation,
    column_id: columnId === NONE ? null : columnId,
    filter_texts: filters.map((f) => filterText(columnName(f.column_id), f)),
    use_table_default_filters: useDefaults,
    numerator_metric_id: numeratorId === NONE ? null : numeratorId,
    denominator_metric_id: denominatorId === NONE ? null : denominatorId,
    ratio_scale: Number(scale) || 1,
    unit,
  });
  const suggestDescription = useFieldSuggestion({
    field: "description",
    getDraft: draft,
    value: description,
    setValue: setDescription,
    request: (d) => suggestMetricField("description", d),
  });
  const suggestSynonyms = useFieldSuggestion({
    field: "synonyms",
    getDraft: draft,
    value: synonyms,
    setValue: setSynonyms,
    request: (d) => suggestMetricField("synonyms", d),
  });
  const suggestExamples = useFieldSuggestion({
    field: "example_questions",
    getDraft: draft,
    value: examples,
    setValue: setExamples,
    request: (d) => suggestMetricField("example_questions", d),
    // add the new questions under the ones already written, skipping repeats
    toValue: (s, current) => {
      const existing = current
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean);
      const seen = new Set(existing.map((q) => q.toLowerCase()));
      const added = (s.questions ?? []).filter(
        (q) => q.trim() && !seen.has(q.trim().toLowerCase()),
      );
      return [...existing, ...added].join("\n");
    },
  });
  // aggregation and column move together, so both hooks keep them as one encoded value
  const calcValue = JSON.stringify([aggregation, columnId]);
  const setCalc = (v: string) => {
    const [agg, col] = JSON.parse(v) as [string, string];
    setAggregation(agg);
    setColumnId(col);
  };
  const suggestAggregation = useFieldSuggestion({
    field: "aggregation",
    getDraft: draft,
    value: calcValue,
    setValue: setCalc,
    request: (d) => suggestMetricCalculation("aggregation", d),
    toValue: (s) =>
      JSON.stringify([s.aggregation ?? NONE, s.column_id ?? NONE]),
  });
  const suggestColumn = useFieldSuggestion({
    field: "column",
    getDraft: draft,
    value: calcValue,
    setValue: setCalc,
    request: (d) => suggestMetricCalculation("column", d),
    toValue: (s) => JSON.stringify([aggregation, s.column_id ?? NONE]),
  });
  // the AI needs at least a name to work from
  const needsName = !displayName.trim() && !name.trim();

  function onDisplayName(v: string) {
    setDisplayName(v);
    if (!nameTouched) setName(slugify(v));
  }

  function onTable(id: string) {
    setEntityId(id);
    setColumnId(NONE);
    setTimeColumnId(NONE);
    setFilters([]);
  }

  // a readable preview of what the metric computes
  let preview = "";
  if (kind === "aggregate") {
    const agg = aggregation === NONE ? "?" : aggregation.toUpperCase();
    const target = columnId === NONE ? "*" : columnName(columnId);
    preview = `${agg}(${target})`;
    const conds = filters.map((f) => filterText(columnName(f.column_id), f));
    if (conds.length) preview += ` where ${conds.join(" and ")}`;
    if (useDefaults && tableDefaults.length)
      preview += ` + table default filters (${tableDefaults.join(" and ")})`;
  } else {
    const n = metrics.find((m) => m.id === numeratorId)?.name ?? "?";
    const d = metrics.find((m) => m.id === denominatorId)?.name ?? "?";
    preview = `${n} / ${d}${Number(scale) !== 1 && scale.trim() ? ` × ${scale}` : ""}`;
  }

  // ── run the SQL once, on request ──
  const [runPeriod, setRunPeriod] = useState("");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<MetricRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  async function handleRun() {
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      setRunResult(
        await runProfileMetric(
          {
            name: name.trim() || "draft_metric",
            display_name: displayName.trim() || "draft",
            kind,
            entity_id: entityId || null,
            aggregation: aggregation === NONE ? null : aggregation,
            column_id: columnId === NONE ? null : columnId,
            filters,
            use_table_default_filters: useDefaults,
            time_column_id: timeColumnId === NONE ? null : timeColumnId,
            numerator_metric_id: numeratorId === NONE ? null : numeratorId,
            denominator_metric_id:
              denominatorId === NONE ? null : denominatorId,
            ratio_scale: Number(scale.replace(",", ".")) || 1,
            reference_values: refs
              .filter(
                (r) =>
                  r.period.trim() &&
                  Number.isFinite(Number(r.value.replace(/[\s,]/g, ""))),
              )
              .map((r) => ({
                period: r.period.trim(),
                value: Number(r.value.replace(/[\s,]/g, "")),
                source: r.source.trim() || null,
              })),
          },
          runPeriod.trim() || null,
        ),
      );
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Could not run the SQL");
    } finally {
      setRunning(false);
    }
  }

  async function handleSave() {
    const errs: string[] = [];
    if (!displayName.trim()) errs.push("Display name is required");
    if (!name.trim()) errs.push("Metric key is required");
    const parsedRefs = refs
      .filter((r) => r.period.trim() || r.value.trim())
      .map((r) => ({
        period: r.period.trim(),
        value: Number(r.value.replace(/[\s,]/g, "")),
        source: r.source.trim() || null,
      }));
    if (parsedRefs.some((r) => !Number.isFinite(r.value)))
      errs.push("Reference values must be numbers");
    const scaleNum = Number(scale.replace(",", "."));
    if (kind === "ratio" && !(scaleNum > 0))
      errs.push("Scale must be a number greater than 0");
    const decimalsNum = decimals.trim() ? Number(decimals) : null;
    if (decimalsNum !== null && !Number.isInteger(decimalsNum))
      errs.push("Decimals must be a whole number");
    if (errs.length) {
      setErrors(errs);
      return;
    }

    const input: MetricInput = {
      name: name.trim(),
      display_name: displayName.trim(),
      description: description.trim() || null,
      synonyms: splitList(synonyms),
      kind,
      entity_id: kind === "aggregate" ? entityId || null : null,
      aggregation:
        kind === "aggregate" && aggregation !== NONE
          ? (aggregation as DefaultAggregation)
          : null,
      column_id: kind === "aggregate" && columnId !== NONE ? columnId : null,
      filters: kind === "aggregate" ? filters : [],
      use_table_default_filters: useDefaults,
      time_column_id:
        kind === "aggregate" && timeColumnId !== NONE ? timeColumnId : null,
      numerator_metric_id:
        kind === "ratio" && numeratorId !== NONE ? numeratorId : null,
      denominator_metric_id:
        kind === "ratio" && denominatorId !== NONE ? denominatorId : null,
      ratio_scale: kind === "ratio" ? scaleNum : 1,
      unit: unit.trim() || null,
      additive: forcedNone
        ? "none"
        : additive === NONE
          ? null
          : (additive as Additive),
      decimals: decimalsNum,
      good_direction:
        direction === NONE ? null : (direction as "up" | "down" | "none"),
      example_questions: examples
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean),
      reference_values: parsedRefs,
      notes: notes.trim() || null,
    };

    setSaving(true);
    setErrors([]);
    try {
      onSaved(
        metric
          ? await updateProfileMetric(metric.id, input)
          : await createProfileMetric(input),
      );
    } catch (err) {
      setErrors(
        (err instanceof Error ? err.message : "Failed to save").split("\n"),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {metric ? `Edit ${metric.name}` : "New metric"}
        </DialogTitle>
        <DialogDescription>
          A business number people ask about.{" "}
          <span className="text-destructive">*</span> required
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4 py-2">
        <Section title="What it is">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <HelpLabel
                help="metric_display_name"
                htmlFor="me_display"
                required
              >
                Display name
              </HelpLabel>
              <Input
                id="me_display"
                value={displayName}
                onChange={(e) => onDisplayName(e.target.value)}
                placeholder="Doanh thu thuần"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="metric_name" htmlFor="me_name" required>
                Metric key
              </HelpLabel>
              <Input
                id="me_name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                placeholder="net_revenue"
                className="font-mono"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel
              help="metric_description"
              htmlFor="me_desc"
              required
              action={
                needsName ? undefined : (
                  <SuggestButton
                    s={suggestDescription}
                    label="the description"
                  />
                )
              }
            >
              Description
            </HelpLabel>
            <Textarea
              id="me_desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What it measures, what is included and excluded"
            />
            <SuggestNote s={suggestDescription} />
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel
              help="metric_synonyms"
              htmlFor="me_syn"
              action={
                needsName ? undefined : (
                  <SuggestButton s={suggestSynonyms} label="other names" />
                )
              }
            >
              Other names (comma-separated)
            </HelpLabel>
            <Input
              id="me_syn"
              value={synonyms}
              onChange={(e) => setSynonyms(e.target.value)}
              placeholder="doanh thu, doanh số, revenue"
            />
            <SuggestNote s={suggestSynonyms} />
          </div>
        </Section>

        <Section title="How it is calculated">
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="metric_kind" required>
              Calculation
            </HelpLabel>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["aggregate", "Aggregate a column of one table"],
                  ["ratio", "Ratio of two metrics"],
                ] as [MetricKind, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setKind(value)}
                  className={`rounded-md border px-3 py-2 text-sm ${
                    kind === value
                      ? "border-primary bg-primary/10 font-medium"
                      : "hover:bg-accent"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {kind === "aggregate" ? (
            <>
              {tables ? (
                <TablePicker
                  tables={tables}
                  value={entityId}
                  onChange={onTable}
                  label="Table"
                  help="metric_table"
                />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
              {entityId && (
                <>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <HelpLabel
                        help="metric_aggregation"
                        required
                        action={
                          needsName ? undefined : (
                            <SuggestButton
                              s={suggestAggregation}
                              label="the aggregation and column"
                            />
                          )
                        }
                      >
                        Aggregation
                      </HelpLabel>
                      <Select
                        value={aggregation}
                        onValueChange={setAggregation}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>—</SelectItem>
                          {AGGREGATIONS.map((a) => (
                            <SelectItem key={a.value} value={a.value}>
                              {a.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <SuggestNote s={suggestAggregation} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <HelpLabel
                        help="metric_column"
                        required={aggregation !== "count"}
                        action={
                          needsName || aggregation === NONE ? undefined : (
                            <SuggestButton
                              s={suggestColumn}
                              label="the column"
                            />
                          )
                        }
                      >
                        Column
                        {aggregation === "count" ? " (empty = count rows)" : ""}
                      </HelpLabel>
                      <Select value={columnId} onValueChange={setColumnId}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>—</SelectItem>
                          {columns
                            .filter(
                              (c) =>
                                !["sum", "avg"].includes(aggregation) ||
                                NUMERIC.includes(c.data_type.toUpperCase()),
                            )
                            .map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                <span className="font-mono">
                                  {c.physical_name}
                                </span>
                                <span className="text-muted-foreground">
                                  {" "}
                                  · {c.data_type}
                                </span>
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <SuggestNote s={suggestColumn} />
                    </div>
                  </div>

                  <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2">
                    <div className="min-w-0">
                      <HelpLabel
                        help="metric_use_defaults"
                        htmlFor="me_defaults"
                      >
                        Also apply the table&apos;s default filters
                      </HelpLabel>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {tableDefaults.length
                          ? `Table default filters: ${tableDefaults.join(" and ")}`
                          : "This table has no default filters."}
                      </p>
                    </div>
                    <Switch
                      id="me_defaults"
                      checked={useDefaults}
                      onCheckedChange={setUseDefaults}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5 md:w-1/2">
                    <HelpLabel help="metric_time_column">Time column</HelpLabel>
                    <Select
                      value={timeColumnId}
                      onValueChange={setTimeColumnId}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>
                          Table&apos;s main time column
                          {tableTimeColumn
                            ? ` (${tableTimeColumn})`
                            : " (none set)"}
                        </SelectItem>
                        {columns
                          .filter(
                            (c) =>
                              [
                                "DATE",
                                "TIMESTAMP",
                                "TIMESTAMPTZ",
                                "DATETIME",
                              ].includes(c.data_type.toUpperCase()) ||
                              c.semantic_type === "date" ||
                              c.semantic_type === "datetime",
                          )
                          .map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              <span className="font-mono">
                                {c.physical_name}
                              </span>
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {isSnapshot && (
                    <p className="text-xs text-muted-foreground">
                      Snapshot table: the metric is taken on the last snapshot
                      date of the period asked.
                    </p>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr_8rem] md:items-end">
              <div className="flex flex-col gap-1.5">
                <HelpLabel help="metric_numerator" required>
                  Numerator
                </HelpLabel>
                <Select value={numeratorId} onValueChange={setNumeratorId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>—</SelectItem>
                    {ratioOptions.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="font-mono">{m.name}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {m.display_name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span className="pb-2 text-center text-lg text-muted-foreground">
                ÷
              </span>
              <div className="flex flex-col gap-1.5">
                <HelpLabel help="metric_denominator" required>
                  Denominator
                </HelpLabel>
                <Select value={denominatorId} onValueChange={setDenominatorId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>—</SelectItem>
                    {ratioOptions.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="font-mono">{m.name}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {m.display_name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <HelpLabel help="metric_scale" htmlFor="me_scale">
                  × Scale
                </HelpLabel>
                <Input
                  id="me_scale"
                  value={scale}
                  onChange={(e) => setScale(e.target.value)}
                  inputMode="decimal"
                />
              </div>
              {ratioOptions.length < 2 && (
                <p className="text-xs text-muted-foreground md:col-span-4">
                  Create the two metrics to divide first (e.g. returning
                  customers and all customers).
                </p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2 rounded-md border p-3">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              Filters of this metric <FieldHelp id="metric_filters" />
            </span>
            {kind === "ratio" ? (
              <p className="text-xs text-muted-foreground">
                A ratio has no filters of its own: it uses the filters of its
                numerator and denominator metrics. To filter, create those
                metrics with the filters you need.
              </p>
            ) : !entityId ? (
              <p className="text-xs text-muted-foreground">
                Pick the table first; filters use its columns and value lists.
              </p>
            ) : table && table.entity.id === entityId ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Only rows matching every filter are counted, e.g. status =
                  CANCELLED for a &ldquo;cancelled orders&rdquo; metric. Leave
                  empty to count all rows (after the table&apos;s default
                  filters, if switched on).
                </p>
                <FilterEditor
                  key={entityId}
                  filters={filters}
                  columns={columns}
                  onChange={setFilters}
                />
              </>
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>

          <div className="flex flex-col gap-2 rounded-md bg-muted px-3 py-2">
            <div className="font-mono text-xs">
              <span className="font-sans text-muted-foreground">
                Calculates:{" "}
              </span>
              {preview}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={runPeriod}
                onChange={(e) => setRunPeriod(e.target.value)}
                placeholder="Period, e.g. 2026-08 (empty = all)"
                className="h-8 w-60 bg-background font-mono text-xs"
                aria-label="Period to run the metric for"
              />
              <Button
                type="button"
                size="sm"
                onClick={handleRun}
                disabled={running}
              >
                {running ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-1 h-4 w-4" />
                )}
                Run SQL
              </Button>
              <span className="text-xs text-muted-foreground">
                Runs one read-only query on Dremio with the form as it is now.
              </span>
            </div>
            {runError && (
              <p className="whitespace-pre-line text-xs text-destructive">
                {runError}
              </p>
            )}
            {runResult && (
              <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-2xl font-semibold tabular-nums">
                    {formatNumber(
                      runResult.value,
                      decimals.trim() ? Number(decimals) : null,
                    )}
                  </span>
                  {unit && (
                    <span className="text-sm text-muted-foreground">
                      {unit}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {runResult.period
                      ? `for ${runResult.period}`
                      : "whole table"}{" "}
                    · {runResult.elapsed_ms} ms
                  </span>
                </div>
                {runResult.reference && (
                  <p
                    className={`flex items-center gap-1.5 text-xs ${
                      runResult.reference.diff_pct !== null &&
                      Math.abs(runResult.reference.diff_pct) <= 1
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-amber-700 dark:text-amber-400"
                    }`}
                  >
                    {runResult.reference.diff_pct !== null &&
                    Math.abs(runResult.reference.diff_pct) <= 1 ? (
                      <CircleCheck className="h-3.5 w-3.5" />
                    ) : (
                      <TriangleAlert className="h-3.5 w-3.5" />
                    )}
                    Reference {formatNumber(runResult.reference.value, null)}
                    {runResult.reference.source
                      ? ` (${runResult.reference.source})`
                      : ""}
                    :{" "}
                    {runResult.reference.diff_pct === null
                      ? "cannot compare"
                      : `${runResult.reference.diff_pct > 0 ? "+" : ""}${runResult.reference.diff_pct.toFixed(1)}%`}
                  </p>
                )}
                {runResult.notes.map((n) => (
                  <p key={n} className="text-xs text-muted-foreground">
                    {n}
                  </p>
                ))}
                {runResult.parts.map((part) => (
                  <details key={part.label} className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      {part.label} SQL
                      {runResult.parts.length > 1
                        ? ` = ${formatNumber(part.value, null)}`
                        : ""}
                    </summary>
                    <SqlPreview sql={part.sql} />
                  </details>
                ))}
              </div>
            )}
          </div>
        </Section>

        <Section title="How it is shown">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="metric_unit" htmlFor="me_unit" required>
                Unit
              </HelpLabel>
              <Input
                id="me_unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="VND, đơn, %"
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <HelpLabel help="metric_additive" required={kind === "aggregate"}>
                Can it be summed?
              </HelpLabel>
              <Select
                value={forcedNone ? "none" : additive}
                onValueChange={setAdditive}
                disabled={forcedNone}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>—</SelectItem>
                  {ADDITIVE.map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {forcedNone && (
                <span className="text-xs text-muted-foreground">
                  Set automatically: {kind === "ratio" ? "ratios" : aggregation}{" "}
                  can never be summed.
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="metric_decimals" htmlFor="me_dec">
                Decimals
              </HelpLabel>
              <Input
                id="me_dec"
                value={decimals}
                onChange={(e) => setDecimals(e.target.value)}
                inputMode="numeric"
                placeholder="auto"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5 md:w-1/2">
            <HelpLabel help="metric_direction">Good direction</HelpLabel>
            <Select value={direction} onValueChange={setDirection}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                <SelectItem value="up">up — higher is better</SelectItem>
                <SelectItem value="down">down — lower is better</SelectItem>
                <SelectItem value="none">none — neither</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Section>

        <Section title="Helping the agent">
          <div className="flex flex-col gap-1.5">
            <HelpLabel
              help="metric_examples"
              htmlFor="me_examples"
              action={
                needsName ? undefined : (
                  <SuggestButton
                    s={suggestExamples}
                    label="example questions"
                  />
                )
              }
            >
              Example questions (one per line)
            </HelpLabel>
            <Textarea
              id="me_examples"
              value={examples}
              onChange={(e) => setExamples(e.target.value)}
              rows={3}
              placeholder={
                "Doanh thu tháng trước theo miền?\nTop 5 chi nhánh doanh thu cao nhất năm nay"
              }
            />
            <SuggestNote s={suggestExamples} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              Reference values <FieldHelp id="metric_references" />
            </span>
            {refs.length > 0 && (
              <div className="grid grid-cols-[8rem_10rem_1fr_2rem] gap-1 text-xs text-muted-foreground">
                <span>Period</span>
                <span>Value</span>
                <span>Source</span>
                <span />
              </div>
            )}
            {refs.map((r, i) => (
              <div
                key={i}
                className="grid grid-cols-[8rem_10rem_1fr_2rem] gap-1"
              >
                <Input
                  value={r.period}
                  onChange={(e) =>
                    setRefs((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, period: e.target.value } : x,
                      ),
                    )
                  }
                  placeholder="2026-08"
                  className="h-8 font-mono text-xs"
                />
                <Input
                  value={r.value}
                  onChange={(e) =>
                    setRefs((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, value: e.target.value } : x,
                      ),
                    )
                  }
                  placeholder="125400000000"
                  className="h-8 text-xs"
                  inputMode="decimal"
                />
                <Input
                  value={r.source}
                  onChange={(e) =>
                    setRefs((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, source: e.target.value } : x,
                      ),
                    )
                  }
                  placeholder="Báo cáo tài chính tháng 8"
                  className="h-8 text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() =>
                    setRefs((prev) => prev.filter((_, j) => j !== i))
                  }
                  aria-label="Remove reference value"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() =>
                setRefs((prev) => [
                  ...prev,
                  { period: "", value: "", source: "" },
                ])
              }
            >
              <Plus className="mr-1 h-4 w-4" /> Add reference value
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="metric_notes" htmlFor="me_notes">
              Notes
            </HelpLabel>
            <Textarea
              id="me_notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </Section>

        {errors.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-destructive">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {metric ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </>
  );
}
