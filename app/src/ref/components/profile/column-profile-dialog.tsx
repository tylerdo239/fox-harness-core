// Copied from bot-data-studio-web-main/src/components/profile/column-profile-dialog.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { JsonFieldsEditor } from "@/components/profile/json-fields-editor";
import { ValueCatalogEditor } from "@/components/profile/value-catalog-editor";
import {
  SuggestButton,
  SuggestNote,
  useFieldSuggestion,
} from "@/components/profile/ai-suggest";
import {
  FieldHelp,
  HelpLabel,
  RequiredMark,
} from "@/components/profile/field-help";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { suggestProfileValue, updateColumnProfile } from "@/lib/api";
import type {
  Additive,
  ColumnProfile,
  ColumnRole,
  DefaultAggregation,
  EntityProfileDetail,
  ProfileColumn,
  SemanticType,
} from "@/lib/types";

const NONE = "__none__";

const ROLES: { value: ColumnRole; hint: string }[] = [
  { value: "key", hint: "identifies a row or links to another table" },
  { value: "dimension", hint: "used to group or filter" },
  { value: "measure", hint: "a number to add up or average" },
];
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
const SEMANTIC_HINTS: Partial<Record<SemanticType, string>> = {
  category: "fixed set of values (enum)",
  text: "free text, names",
  id: "codes, ids",
  number: "setting or position — compare, sort, never sum",
  count: "a quantity you add up",
  currency: "money",
  boolean: "yes/no",
};
const DATE_TYPES = ["DATE", "TIME", "TIMESTAMP", "TIMESTAMPTZ", "DATETIME"];
const DATE_FORMATS = [
  "YYYYMMDD",
  "YYYY-MM-DD",
  "DD/MM/YYYY",
  "YYYYMM",
  "YYYY-MM",
  "YYYY",
  "YYYY-MM-DD HH:MI:SS",
  "EPOCH_SECONDS",
  "EPOCH_MILLIS",
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
  {
    value: "all",
    label: "Yes — can be summed across everything, including time",
  },
  {
    value: "not_time",
    label:
      "Not across time — e.g. stock, balance (sum across branches is fine)",
  },
  { value: "none", label: "Never — e.g. price, ratio, distinct count" },
];

function numOrNull(text: string): number | null {
  if (!text.trim()) return null;
  const n = Number(text.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function textOrNull(text: string): string | null {
  return text.trim() || null;
}

export function ColumnProfileDialog({
  entityId,
  column,
  columns,
  open,
  onOpenChange,
  onSaved,
  onNavigate,
  position,
}: {
  entityId: string;
  column: ProfileColumn;
  /** every column of the table, for picking the parent column */
  columns: ProfileColumn[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (detail: EntityProfileDetail) => void;
  /** move to the previous (-1) or next (+1) column in the list; omitted = no navigation */
  onNavigate?: (direction: -1 | 1) => void;
  position?: { index: number; total: number };
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        {open && (
          <ColumnForm
            key={column.id}
            entityId={entityId}
            column={column}
            columns={columns}
            position={position}
            onNavigate={onNavigate}
            onCancel={() => onOpenChange(false)}
            onSaved={(d, andNext) => {
              onSaved(d);
              if (andNext && onNavigate) onNavigate(1);
              else onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ColumnForm({
  entityId,
  column,
  columns,
  position,
  onNavigate,
  onCancel,
  onSaved,
}: {
  entityId: string;
  column: ProfileColumn;
  columns: ProfileColumn[];
  position?: { index: number; total: number };
  onNavigate?: (direction: -1 | 1) => void;
  onCancel: () => void;
  onSaved: (detail: EntityProfileDetail, andNext: boolean) => void;
}) {
  const p = column.profile;
  const [displayName, setDisplayName] = useState(column.display_name);
  const [description, setDescription] = useState(column.description ?? "");
  const [synonyms, setSynonyms] = useState(column.synonyms.join(", "));
  const [role, setRole] = useState<string>(column.role ?? NONE);
  const [semanticType, setSemanticType] = useState<string>(
    column.semantic_type ?? NONE,
  );

  // the dialog's unsaved values, sent as context with every AI suggestion
  const draft = () => ({
    display_name: displayName,
    description,
    synonyms: synonyms
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    role: role === NONE ? null : role,
    semantic_type: semanticType === NONE ? null : semanticType,
  });
  const suggestOptions = {
    entityId,
    target: "column" as const,
    columnId: column.id,
    getDraft: draft,
  };
  const suggestName = useFieldSuggestion({
    ...suggestOptions,
    field: "display_name",
    value: displayName,
    setValue: setDisplayName,
  });
  const suggestSynonyms = useFieldSuggestion({
    ...suggestOptions,
    field: "synonyms",
    value: synonyms,
    setValue: setSynonyms,
  });
  const suggestDescription = useFieldSuggestion({
    ...suggestOptions,
    field: "description",
    value: description,
    setValue: setDescription,
  });
  const [aggregation, setAggregation] = useState<string>(
    column.default_aggregation ?? NONE,
  );
  const [isExposed, setIsExposed] = useState(column.is_exposed);
  const [isPii, setIsPii] = useState(column.is_pii);

  const [catalog, setCatalog] = useState(p.value_catalog);
  const [catalogComplete, setCatalogComplete] = useState(
    p.value_catalog_complete,
  );
  const [valuesOrdered, setValuesOrdered] = useState(p.values_ordered);
  const [pattern, setPattern] = useState(p.pattern ?? "");
  const [dateFormat, setDateFormat] = useState(p.date_format ?? "");
  const [parentColumnId, setParentColumnId] = useState<string>(
    p.parent_column_id ?? NONE,
  );
  const [unit, setUnit] = useState(p.unit ?? "");
  const [scale, setScale] = useState(p.scale === null ? "" : String(p.scale));
  const [additive, setAdditive] = useState<string>(p.additive ?? NONE);
  const [signConvention, setSignConvention] = useState(p.sign_convention ?? "");
  const [nullMeaning, setNullMeaning] = useState(p.null_meaning ?? "");
  const [normalMin, setNormalMin] = useState(
    p.normal_min === null ? "" : String(p.normal_min),
  );
  const [normalMax, setNormalMax] = useState(
    p.normal_max === null ? "" : String(p.normal_max),
  );
  const [notes, setNotes] = useState(p.notes ?? "");
  const [jsonFields, setJsonFields] = useState(p.json_fields ?? []);
  // JSON lives in text columns; show the section there, or wherever fields already exist
  const canHoldJson =
    ["VARCHAR", "CHAR", "STRING", "CHARACTER VARYING"].includes(column.data_type.toUpperCase()) ||
    jsonFields.length > 0;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMeasure = role === "measure";
  const isDate = semanticType === "date" || semanticType === "datetime";
  const dateStoredAsText = !DATE_TYPES.includes(column.data_type.toUpperCase());
  const hasNext =
    !!onNavigate && !!position && position.index < position.total - 1;
  const showCatalog =
    semanticType === "category" ||
    semanticType === "boolean" ||
    catalog.length > 0;

  async function handleSave(andNext: boolean) {
    setSaving(true);
    setError(null);
    const profile: ColumnProfile = {
      value_catalog: catalog,
      value_catalog_complete: catalogComplete,
      values_ordered: valuesOrdered,
      pattern: textOrNull(pattern),
      date_format: isDate ? textOrNull(dateFormat) : null,
      parent_column_id: parentColumnId === NONE ? null : parentColumnId,
      unit: textOrNull(unit),
      scale: numOrNull(scale),
      additive: additive === NONE ? null : (additive as Additive),
      sign_convention: textOrNull(signConvention),
      null_meaning: textOrNull(nullMeaning),
      normal_min: numOrNull(normalMin),
      normal_max: numOrNull(normalMax),
      notes: textOrNull(notes),
      json_fields: jsonFields,
    };
    try {
      const detail = await updateColumnProfile(entityId, column.id, {
        display_name: displayName.trim() || column.physical_name,
        description: textOrNull(description),
        synonyms: synonyms
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        role: role === NONE ? null : (role as ColumnRole),
        semantic_type:
          semanticType === NONE ? null : (semanticType as SemanticType),
        default_aggregation:
          isMeasure && aggregation !== NONE
            ? (aggregation as DefaultAggregation)
            : null,
        is_exposed: isExposed,
        is_pii: isPii,
        profile,
      });
      onSaved(detail, andNext);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save column");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-mono">{column.physical_name}</DialogTitle>
        <DialogDescription>
          {column.data_type}
          {position && ` · column ${position.index + 1} of ${position.total}`}
          {" · "}
          <span className="text-destructive">*</span> required
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-5 py-2">
        <section className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <HelpLabel
                help="column_display_name"
                htmlFor="cp_display"
                action={
                  <SuggestButton s={suggestName} label="the display name" />
                }
              >
                Display name
              </HelpLabel>
              <Input
                id="cp_display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
              <SuggestNote s={suggestName} />
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel
                help="column_synonyms"
                htmlFor="cp_synonyms"
                action={<SuggestButton s={suggestSynonyms} label="synonyms" />}
              >
                Synonyms (comma-separated)
              </HelpLabel>
              <Input
                id="cp_synonyms"
                value={synonyms}
                onChange={(e) => setSynonyms(e.target.value)}
                placeholder="doanh thu, doanh số"
              />
              <SuggestNote s={suggestSynonyms} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel
              help="column_description"
              htmlFor="cp_description"
              action={
                <SuggestButton s={suggestDescription} label="the description" />
              }
            >
              Description
            </HelpLabel>
            <Textarea
              id="cp_description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What the column holds, in the words people use"
            />
            <SuggestNote s={suggestDescription} />
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="role" required={isExposed}>
              Role
            </HelpLabel>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.value} — {r.hint}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="semantic_type" required={isExposed}>
              Semantic type
            </HelpLabel>
            <Select value={semanticType} onValueChange={setSemanticType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {SEMANTIC_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                    {SEMANTIC_HINTS[t] && (
                      <span className="text-muted-foreground">
                        {" "}
                        — {SEMANTIC_HINTS[t]}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {role === "dimension" &&
              (semanticType === "text" || semanticType === NONE) &&
              catalog.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  A fixed set of values, like an enum?{" "}
                  <button
                    type="button"
                    className="font-medium text-primary underline-offset-2 hover:underline"
                    onClick={() => setSemanticType("category")}
                  >
                    Use category and list the values
                  </button>
                </p>
              )}
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <HelpLabel help="column_visible" htmlFor="cp_exposed">
              Visible to the agent
            </HelpLabel>
            <Switch
              id="cp_exposed"
              checked={isExposed}
              onCheckedChange={setIsExposed}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <HelpLabel help="pii" htmlFor="cp_pii">
              Personal data (PII)
            </HelpLabel>
            <Switch id="cp_pii" checked={isPii} onCheckedChange={setIsPii} />
          </div>
        </section>

        {semanticType === "number" && !isMeasure && (
          <section className="flex flex-col gap-1.5 md:w-1/2">
            <HelpLabel help="unit" htmlFor="cp_number_unit">
              Unit (optional)
            </HelpLabel>
            <Input
              id="cp_number_unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="e.g. ms, giây, token — empty if none"
            />
            <span className="text-xs text-muted-foreground">
              The agent can filter and sort by this number (&gt;, &lt;, highest,
              lowest) but never sums it.
            </span>
          </section>
        )}

        {isMeasure && (
          <section className="flex flex-col gap-3 rounded-md border p-3">
            <h3 className="text-sm font-semibold">Measure</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <HelpLabel help="aggregation" required={isExposed && isMeasure}>
                  Aggregation
                </HelpLabel>
                <Select value={aggregation} onValueChange={setAggregation}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>—</SelectItem>
                    {AGGREGATIONS.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <HelpLabel
                  help="unit"
                  required={isExposed && isMeasure}
                  htmlFor="cp_unit"
                >
                  Unit
                </HelpLabel>
                <Input
                  id="cp_unit"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="VND, cái, %"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <HelpLabel help="scale" htmlFor="cp_scale">
                  Scale
                </HelpLabel>
                <Input
                  id="cp_scale"
                  value={scale}
                  onChange={(e) => setScale(e.target.value)}
                  placeholder="1 (1000 = stored in thousands)"
                  inputMode="decimal"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="additive" required={isExposed && isMeasure}>
                Can it be summed?
              </HelpLabel>
              <Select value={additive} onValueChange={setAdditive}>
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
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <HelpLabel help="normal_range" htmlFor="cp_min">
                  Normal range: min
                </HelpLabel>
                <Input
                  id="cp_min"
                  value={normalMin}
                  onChange={(e) => setNormalMin(e.target.value)}
                  inputMode="decimal"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <HelpLabel help="normal_range" htmlFor="cp_max">
                  Normal range: max
                </HelpLabel>
                <Input
                  id="cp_max"
                  value={normalMax}
                  onChange={(e) => setNormalMax(e.target.value)}
                  inputMode="decimal"
                  placeholder="values above look wrong"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="sign_convention" htmlFor="cp_sign">
                Sign convention
              </HelpLabel>
              <Input
                id="cp_sign"
                value={signConvention}
                onChange={(e) => setSignConvention(e.target.value)}
                placeholder="e.g. always ≥ 0; refunds are negative"
              />
            </div>
          </section>
        )}

        {showCatalog && (
          <section className="flex flex-col gap-3 rounded-md border p-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  Values
                  {isExposed &&
                    (semanticType === "category" ||
                      semanticType === "boolean") && <RequiredMark />}
                  <FieldHelp id="values" />
                </h3>
                <p className="text-xs text-muted-foreground">
                  Every value the column can take, what it means, and other
                  words people use for it.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="cp_complete" className="text-xs">
                  List is complete
                </Label>
                <FieldHelp id="values_complete" />
                <Switch
                  id="cp_complete"
                  checked={catalogComplete}
                  onCheckedChange={setCatalogComplete}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="cp_ordered"
                checked={valuesOrdered}
                onCheckedChange={setValuesOrdered}
              />
              <Label htmlFor="cp_ordered" className="text-xs font-normal">
                The values have a natural order (e.g. Bronze &lt; Silver &lt;
                Gold) — arrange them from first to last
              </Label>
              <FieldHelp id="values_ordered" />
            </div>
            <ValueCatalogEditor
              items={catalog}
              booleanPreset={semanticType === "boolean" || column.data_type.toUpperCase() === "BOOLEAN"}
              onChange={setCatalog}
              ordered={valuesOrdered}
              suggest={(value, others) =>
                suggestProfileValue(entityId, {
                  column_id: column.id,
                  value,
                  draft: {
                    display_name: displayName,
                    description,
                    values: others,
                  },
                })
              }
            />
          </section>
        )}

        {isDate && (
          <section className="flex flex-col gap-1.5 rounded-md border p-3">
            <span className="flex items-center gap-1.5">
              <Label htmlFor="cp_datefmt">
                Date format{isExposed && dateStoredAsText && <RequiredMark />}
              </Label>
              <FieldHelp id="date_format" />
            </span>
            <Input
              id="cp_datefmt"
              list="date-format-options"
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value)}
              placeholder={
                dateStoredAsText
                  ? "YYYYMMDD"
                  : "not needed for a real date column"
              }
              className="font-mono md:w-1/2"
            />
            <datalist id="date-format-options">
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <span className="text-xs text-muted-foreground">
              {dateStoredAsText
                ? `This column is stored as ${column.data_type}, so write how the date is written, e.g. 20240115 → YYYYMMDD, 2024-01 → YYYY-MM.`
                : `Stored as ${column.data_type}: a real date type, leave empty.`}
            </span>
          </section>
        )}

        {role === "dimension" && (
          <section className="flex flex-col gap-1.5 md:w-1/2">
            <HelpLabel help="parent_column">
              Parent column (next level up)
            </HelpLabel>
            <Select value={parentColumnId} onValueChange={setParentColumnId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {columns
                  .filter((c) => c.id !== column.id)
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.physical_name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              For levels such as province → region or product → category, both
              in this table
            </span>
          </section>
        )}

        {canHoldJson && (
          <section className="flex flex-col gap-3 rounded-md border p-3">
            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                JSON fields <FieldHelp id="json_fields" />
              </h3>
              <p className="text-xs text-muted-foreground">
                If this column holds JSON, declare the fields inside it. Each field can then be used like a
                column in filters, segments and metrics (shown as{" "}
                <span className="font-mono">{column.physical_name}.field</span>).
              </p>
            </div>
            <JsonFieldsEditor
              entityId={entityId}
              columnId={column.id}
              columnName={column.physical_name}
              fields={jsonFields}
              onChange={setJsonFields}
            />
          </section>
        )}

        <section className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="null_meaning" htmlFor="cp_null">
              What an empty value means
            </HelpLabel>
            <Input
              id="cp_null"
              value={nullMeaning}
              onChange={(e) => setNullMeaning(e.target.value)}
              placeholder="e.g. cancelled order, no amount"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="pattern" htmlFor="cp_pattern">
              Format example
            </HelpLabel>
            <Input
              id="cp_pattern"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="e.g. BR-0001, CUS-00012345"
              className="font-mono"
            />
          </div>
          <div className="col-span-2 flex flex-col gap-1.5">
            <HelpLabel help="column_notes" htmlFor="cp_notes">
              Notes
            </HelpLabel>
            <Textarea
              id="cp_notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </section>

        {error && (
          <p className="whitespace-pre-line text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <DialogFooter className="gap-2 sm:justify-between">
        <div className="flex gap-2">
          {onNavigate && position && (
            <>
              <Button
                variant="outline"
                onClick={() => onNavigate(-1)}
                disabled={saving || position.index === 0}
                title="Go to the previous column without saving"
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                onClick={() => onNavigate(1)}
                disabled={saving || position.index >= position.total - 1}
                title="Go to the next column without saving"
              >
                Skip
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {hasNext ? (
            <>
              <Button
                variant="outline"
                onClick={() => handleSave(false)}
                disabled={saving}
              >
                Save &amp; close
              </Button>
              <Button onClick={() => handleSave(true)} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save &amp; next
              </Button>
            </>
          ) : (
            <Button onClick={() => handleSave(false)} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save &amp; close
            </Button>
          )}
        </div>
      </DialogFooter>
    </>
  );
}
