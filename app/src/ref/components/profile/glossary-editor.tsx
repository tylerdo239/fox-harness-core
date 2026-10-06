// Copied from bot-data-studio-web-main/src/components/profile/glossary-editor.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useEffect, useState, type ReactNode } from "react";
import { Database, Loader2, Play, X } from "lucide-react";
import { SuggestButton, SuggestNote, useFieldSuggestion } from "@/components/profile/ai-suggest";
import { HelpLabel } from "@/components/profile/field-help";
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
import { Textarea } from "@/components/ui/textarea";
import {
  createGlossaryItem,
  getEntityProfile,
  getProfileMetrics,
  getProfileTables,
  runGlossarySegment,
  suggestGlossaryField,
  updateGlossaryItem,
} from "@/lib/api";
import type {
  EntityProfileDetail,
  GlossaryInput,
  GlossaryItem,
  MetricItem,
  MetricRunResult,
  TableOption,
  TermKind,
  TypedFilter,
} from "@/lib/types";

const NONE = "__none__";
const KINDS: { value: TermKind; label: string; hint: string }[] = [
  { value: "segment", label: "Segment", hint: "a group of rows, e.g. khách VIP" },
  { value: "metric", label: "Metric name", hint: "another name for a metric" },
  { value: "definition", label: "Convention", hint: "a rule in words, e.g. tăng trưởng" },
];

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((q) => q.trim())
    .filter(Boolean);
}

function filterText(column: string, f: TypedFilter): string {
  if (f.op === "is_null") return `${column} is empty`;
  if (f.op === "is_not_null") return `${column} is not empty`;
  const op = f.op === "not_in" ? "not in" : f.op === "!=" ? "≠" : f.op;
  return `${column} ${op} ${f.values.join(", ")}`;
}

export function GlossaryEditor({
  item,
  trigger,
  onSaved,
}: {
  item?: GlossaryItem;
  trigger: ReactNode;
  onSaved: (item: GlossaryItem) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        {open && (
          <GlossaryForm
            item={item}
            onCancel={() => setOpen(false)}
            onSaved={(saved) => {
              onSaved(saved);
              setOpen(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GlossaryForm({
  item,
  onCancel,
  onSaved,
}: {
  item?: GlossaryItem;
  onCancel: () => void;
  onSaved: (item: GlossaryItem) => void;
}) {
  const [tables, setTables] = useState<TableOption[] | null>(null);
  const [metrics, setMetrics] = useState<MetricItem[] | null>(null);
  const [table, setTable] = useState<EntityProfileDetail | null>(null);

  const [term, setTerm] = useState(item?.term ?? "");
  const [synonyms, setSynonyms] = useState(item?.synonyms.join(", ") ?? "");
  const [kind, setKind] = useState<TermKind>(item?.kind ?? "segment");
  const [definition, setDefinition] = useState(item?.definition ?? "");
  const [entityId, setEntityId] = useState(item?.entity_id ?? "");
  const [filters, setFilters] = useState<TypedFilter[]>(item?.filters ?? []);
  const [metricId, setMetricId] = useState<string>(item?.metric_id ?? NONE);
  const [related, setRelated] = useState<string[]>(item?.related_entity_ids ?? []);
  const [relatedQuery, setRelatedQuery] = useState("");
  const [examples, setExamples] = useState(item?.example_questions.join("\n") ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");

  const [runPeriod, setRunPeriod] = useState("");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<MetricRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    getProfileTables()
      .then(setTables)
      .catch((err) => setErrors([err instanceof Error ? err.message : "Failed to load tables"]));
    getProfileMetrics()
      .then(setMetrics)
      .catch((err) => setErrors([err instanceof Error ? err.message : "Failed to load metrics"]));
  }, []);

  useEffect(() => {
    if (!entityId) return;
    getEntityProfile(entityId)
      .then(setTable)
      .catch((err) => setErrors([err instanceof Error ? err.message : "Failed to load the table"]));
  }, [entityId]);

  // real columns plus declared JSON fields (config.is_intent_node…)
  const columns = table && table.entity.id === entityId ? withJsonFields(table.columns) : [];
  const columnName = (id: string) => columns.find((c) => c.id === id)?.physical_name ?? "?";
  const tableName = (id: string) => tables?.find((t) => t.entity_id === id);

  // the form as it is now, sent with every AI suggestion
  const draft = () => ({
    term,
    kind,
    definition,
    synonyms: splitList(synonyms),
    example_questions: lines(examples),
    entity_id: entityId || null,
    filter_texts: filters.map((f) => filterText(columnName(f.column_id), f)),
    metric_id: metricId === NONE ? null : metricId,
    related_entity_ids: related,
  });
  const suggestDefinition = useFieldSuggestion({
    field: "description",
    getDraft: draft,
    value: definition,
    setValue: setDefinition,
    request: (d) => suggestGlossaryField("definition", d),
  });
  const suggestSynonyms = useFieldSuggestion({
    field: "synonyms",
    getDraft: draft,
    value: synonyms,
    setValue: setSynonyms,
    request: (d) => suggestGlossaryField("synonyms", d),
  });
  const suggestExamples = useFieldSuggestion({
    field: "example_questions",
    getDraft: draft,
    value: examples,
    setValue: setExamples,
    request: (d) => suggestGlossaryField("example_questions", d),
    toValue: (s, current) => {
      const existing = lines(current);
      const seen = new Set(existing.map((q) => q.toLowerCase()));
      const added = (s.questions ?? []).filter((q) => q.trim() && !seen.has(q.trim().toLowerCase()));
      return [...existing, ...added].join("\n");
    },
  });
  const noTerm = !term.trim();

  async function handleRun() {
    if (!entityId) return;
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      setRunResult(await runGlossarySegment(entityId, filters, runPeriod.trim() || null));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Could not run the SQL");
    } finally {
      setRunning(false);
    }
  }

  async function handleSave() {
    if (noTerm) {
      setErrors(["Type the term"]);
      return;
    }
    const input: GlossaryInput = {
      term: term.trim(),
      synonyms: splitList(synonyms),
      definition: definition.trim() || null,
      kind,
      entity_id: kind === "segment" ? entityId || null : null,
      filters: kind === "segment" ? filters : [],
      metric_id: kind === "metric" && metricId !== NONE ? metricId : null,
      related_entity_ids: kind === "definition" ? related : [],
      example_questions: lines(examples),
      notes: notes.trim() || null,
    };
    setSaving(true);
    setErrors([]);
    try {
      onSaved(item ? await updateGlossaryItem(item.id, input) : await createGlossaryItem(input));
    } catch (err) {
      setErrors((err instanceof Error ? err.message : "Failed to save").split("\n"));
    } finally {
      setSaving(false);
    }
  }

  const q = relatedQuery.trim().toLowerCase();
  const relatedOptions = (tables ?? [])
    .filter((t) => !related.includes(t.entity_id))
    .filter((t) => !q || t.physical_path.toLowerCase().includes(q) || t.display_name.toLowerCase().includes(q))
    .slice(0, 50);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{item ? `Edit “${item.term}”` : "New glossary term"}</DialogTitle>
        <DialogDescription>
          A word people use that needs one fixed meaning. <span className="text-destructive">*</span> required
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4 py-2">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="glossary_term" htmlFor="ge_term" required>
              Term
            </HelpLabel>
            <Input id="ge_term" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="khách VIP" />
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel
              help="glossary_synonyms"
              htmlFor="ge_syn"
              action={noTerm ? undefined : <SuggestButton s={suggestSynonyms} label="other ways to say it" />}
            >
              Other ways to say it (comma-separated)
            </HelpLabel>
            <Input
              id="ge_syn"
              value={synonyms}
              onChange={(e) => setSynonyms(e.target.value)}
              placeholder="khách thân thiết, VIP customer"
            />
            <SuggestNote s={suggestSynonyms} />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <HelpLabel help="glossary_kind" required>
            What kind of term
          </HelpLabel>
          <div className="flex flex-wrap gap-2">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                onClick={() => setKind(k.value)}
                className={`rounded-md border px-3 py-2 text-left text-sm ${
                  kind === k.value ? "border-primary bg-primary/10" : "hover:bg-accent"
                }`}
              >
                <span className="font-medium">{k.label}</span>
                <span className="block text-xs text-muted-foreground">{k.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {kind === "segment" && (
          <section className="flex flex-col gap-3 rounded-md border p-3">
            {tables ? (
              <TablePicker
                tables={tables}
                value={entityId}
                onChange={(id) => {
                  setEntityId(id);
                  setFilters([]);
                  setRunResult(null);
                }}
                label="Table"
                help="glossary_table"
              />
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            <div className="flex flex-col gap-2">
              <HelpLabel help="glossary_filters" required>
                Rows belong to the term (are kept) when
              </HelpLabel>
              {!entityId ? (
                <p className="text-xs text-muted-foreground">Pick the table first.</p>
              ) : table && table.entity.id === entityId ? (
                <FilterEditor key={entityId} filters={filters} columns={columns} onChange={setFilters} />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>
            {entityId && (
              <div className="flex flex-col gap-2 rounded-md bg-muted px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={runPeriod}
                    onChange={(e) => setRunPeriod(e.target.value)}
                    placeholder="Period, e.g. 2026-08 (empty = all)"
                    className="h-8 w-60 bg-background font-mono text-xs"
                    aria-label="Period to count the rows for"
                  />
                  <Button type="button" size="sm" onClick={handleRun} disabled={running}>
                    {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />}
                    Count rows
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Runs one read-only query, with the table&apos;s default filters too.
                  </span>
                </div>
                {runError && <p className="whitespace-pre-line text-xs text-destructive">{runError}</p>}
                {runResult && (
                  <div className="flex flex-col gap-1 rounded-md border bg-background p-2 text-xs">
                    <span>
                      <span className="text-lg font-semibold tabular-nums">
                        {runResult.value === null ? "empty" : runResult.value.toLocaleString("vi-VN")}
                      </span>{" "}
                      rows {runResult.period ? `in ${runResult.period}` : "in the whole table"} ·{" "}
                      {runResult.elapsed_ms} ms
                    </span>
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">SQL</summary>
                      <SqlPreview sql={runResult.parts[0]?.sql ?? ""} />
                    </details>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {kind === "metric" && (
          <section className="flex flex-col gap-1.5 rounded-md border p-3">
            <HelpLabel help="glossary_metric" required>
              The metric this term means
            </HelpLabel>
            {metrics ? (
              metrics.length === 0 ? (
                <p className="text-xs text-muted-foreground">No metrics yet. Create the metric on the Metrics page first.</p>
              ) : (
                <Select value={metricId} onValueChange={setMetricId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>—</SelectItem>
                    {metrics.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="font-mono">{m.name}</span>
                        <span className="text-muted-foreground"> · {m.display_name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </section>
        )}

        {kind === "definition" && (
          <section className="flex flex-col gap-2 rounded-md border p-3">
            <HelpLabel help="glossary_related_tables">Related tables</HelpLabel>
            {related.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {related.map((id) => (
                  <span key={id} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs text-primary">
                    {tableName(id)?.physical_path ?? id}
                    <button
                      type="button"
                      onClick={() => setRelated((prev) => prev.filter((x) => x !== id))}
                      aria-label="Remove table"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <Input
              value={relatedQuery}
              onChange={(e) => setRelatedQuery(e.target.value)}
              placeholder="Search tables to add"
              className="h-8 text-sm"
            />
            {relatedQuery.trim() && (
              <div className="max-h-40 overflow-y-auto rounded-md border">
                {relatedOptions.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No tables match.</p>}
                {relatedOptions.map((t) => (
                  <button
                    key={t.entity_id}
                    type="button"
                    onClick={() => {
                      setRelated((prev) => [...prev, t.entity_id]);
                      setRelatedQuery("");
                    }}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent"
                  >
                    <Database className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs font-semibold text-primary">{t.physical_path}</span>
                    <span className="truncate text-xs text-muted-foreground">{t.display_name}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        <div className="flex flex-col gap-1.5">
          <HelpLabel
            help="glossary_definition"
            htmlFor="ge_def"
            required
            action={noTerm ? undefined : <SuggestButton s={suggestDefinition} label="the definition" />}
          >
            {kind === "definition" ? "The convention" : "Definition"}
          </HelpLabel>
          <Textarea
            id="ge_def"
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
            rows={kind === "definition" ? 4 : 2}
            placeholder={
              kind === "definition"
                ? "Tăng trưởng = (kỳ này − kỳ trước) / kỳ trước, tính theo %. Bỏ đối tượng không có số kỳ trước."
                : "What the term means, what it includes and excludes"
            }
          />
          <SuggestNote s={suggestDefinition} />
        </div>

        <div className="flex flex-col gap-1.5">
          <HelpLabel
            help="glossary_examples"
            htmlFor="ge_examples"
            action={noTerm ? undefined : <SuggestButton s={suggestExamples} label="example questions" />}
          >
            Example questions (one per line)
          </HelpLabel>
          <Textarea
            id="ge_examples"
            value={examples}
            onChange={(e) => setExamples(e.target.value)}
            rows={3}
            placeholder="Có bao nhiêu khách VIP mua hàng tháng trước?"
          />
          <SuggestNote s={suggestExamples} />
        </div>

        <div className="flex flex-col gap-1.5">
          <HelpLabel help="glossary_notes" htmlFor="ge_notes">
            Notes
          </HelpLabel>
          <Textarea id="ge_notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>

        <p className="text-xs text-muted-foreground">Every save is added to the agent&apos;s search index.</p>

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
          {item ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </>
  );
}
