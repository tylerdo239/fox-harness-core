// Copied from bot-data-studio-web-main/src/components/profile/value-catalog-editor.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  ListPlus,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { FieldHelp } from "@/components/profile/field-help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  SuggestionConfidence,
  ValueCatalogItem,
  ValueSuggestion,
} from "@/lib/types";

interface Row {
  id: string; // unique key so per-row state survives reordering and deleting
  value: string;
  label: string;
  synonyms: string;
  count: string;
}

// random per row: a shared counter can restart (e.g. on a code reload) and give two rows one id
function newRowId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toRow(item: ValueCatalogItem): Row {
  return {
    id: newRowId(),
    value: item.value,
    label: item.label ?? "",
    synonyms: item.synonyms.join(", "),
    count: item.count === null ? "" : String(item.count),
  };
}

function toItem(row: Row): ValueCatalogItem {
  const count = Number(row.count.replace(/[.,\s]/g, ""));
  return {
    value: row.value.trim(),
    label: row.label.trim() || null,
    synonyms: row.synonyms
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    count: row.count.trim() && Number.isFinite(count) ? count : null,
  };
}

type PasteMode = "values" | "table";

/** Pasted lines. values: each whole line is one value. table: value [TAB] label [TAB] synonyms [TAB]
 *  count (as copied from a table). Blank lines and repeats are left out. */
function parsePasted(text: string, mode: PasteMode): Row[] {
  const seen = new Set<string>();
  return text
    .split(/\r?\n/)
    .map((line) => (mode === "values" ? [line] : line.split("\t")))
    .filter((cells) => cells[0]?.trim())
    .map(([value, label = "", synonyms = "", count = ""]) => ({
      id: newRowId(),
      value: value.trim(),
      label: label.trim(),
      synonyms: synonyms.trim(),
      count: count.trim(),
    }))
    .filter((r) => !seen.has(r.value) && Boolean(seen.add(r.value)));
}

interface RowSuggestion {
  loading: boolean;
  error?: string;
  confidence?: SuggestionConfidence;
  note?: string | null;
  previous?: { label: string; synonyms: string };
}

const CONFIDENCE_LABEL: Record<SuggestionConfidence, string> = {
  high: "confident",
  medium: "a guess",
  low: "unsure — please check",
};

export function ValueCatalogEditor({
  items,
  onChange,
  ordered = false,
  suggest,
  booleanPreset = false,
}: {
  items: ValueCatalogItem[];
  onChange: (items: ValueCatalogItem[]) => void;
  /** show up/down buttons: the list order is the natural order of the values */
  ordered?: boolean;
  /** AI label + synonyms for one value; `others` are the other rows, for context */
  suggest?: (
    value: string,
    others: { value: string; label: string | null }[],
  ) => Promise<ValueSuggestion>;
  /** boolean column: offer a one-click "true / false" list */
  booleanPreset?: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(() => items.map(toRow));
  // the latest rows, for AI answers that arrive after other edits
  const rowsRef = useRef(rows);
  const [suggestions, setSuggestions] = useState<Record<string, RowSuggestion>>(
    {},
  );
  const [pasting, setPasting] = useState<PasteMode | null>(null);
  const [pasteText, setPasteText] = useState("");

  function update(next: Row[]) {
    rowsRef.current = next;
    setRows(next);
    onChange(next.filter((r) => r.value.trim()).map(toItem));
  }

  function setCell(
    index: number,
    key: Exclude<keyof Row, "id">,
    value: string,
  ) {
    update(rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  }

  function setSuggestion(id: string, state: RowSuggestion | null) {
    setSuggestions((prev) => {
      const next = { ...prev };
      if (state) next[id] = state;
      else delete next[id];
      return next;
    });
  }

  async function runSuggest(row: Row) {
    if (!suggest) return;
    if (!row.value.trim()) return;
    setSuggestion(row.id, { loading: true });
    const value = row.value.trim();
    try {
      const others = rows
        .filter((r) => r.id !== row.id && r.value.trim())
        .map((r) => ({ value: r.value.trim(), label: r.label.trim() || null }));
      const s = await suggest(value, others);
      // apply to the same row by id, using its latest state; drop the answer if the row was
      // deleted or its value changed while waiting
      const current = rowsRef.current.find((r) => r.id === row.id);
      if (!current || current.value.trim() !== value) {
        setSuggestion(row.id, null);
        return;
      }
      const previous = { label: current.label, synonyms: current.synonyms };
      update(
        rowsRef.current.map((r) =>
          r.id === row.id
            ? { ...r, label: s.label, synonyms: s.synonyms.join(", ") }
            : r,
        ),
      );
      setSuggestion(row.id, {
        loading: false,
        confidence: s.confidence,
        note: s.note,
        previous,
      });
    } catch (err) {
      setSuggestion(row.id, {
        loading: false,
        error:
          err instanceof Error
            ? err.message
            : "The AI could not suggest this value",
      });
    }
  }

  function undoSuggest(row: Row) {
    const prev = suggestions[row.id]?.previous;
    if (prev)
      update(rows.map((r) => (r.id === row.id ? { ...r, ...prev } : r)));
    setSuggestion(row.id, null);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    update(next);
  }

  // the rows a paste would add: values already in the list are skipped
  const existingValues = new Set(rows.map((r) => r.value.trim()));
  const toAdd = pasting ? parsePasted(pasteText, pasting).filter((r) => !existingValues.has(r.value)) : [];

  function addPasted() {
    update([...rows.filter((r) => r.value.trim()), ...toAdd]);
    setPasteText("");
    setPasting(null);
  }

  const cols = ordered
    ? "grid-cols-[4rem_1fr_1fr_1.3fr_5rem_2rem_2rem]"
    : "grid-cols-[1fr_1fr_1.3fr_5rem_2rem_2rem]";

  const duplicates = new Set(
    rows
      .map((r) => r.value.trim())
      .filter((v, i, all) => v && all.indexOf(v) !== i),
  );

  return (
    <div className="flex flex-col gap-2">
      {rows.length > 0 && (
        <div
          className={`grid ${cols} gap-1 text-xs font-medium text-muted-foreground`}
        >
          {ordered && <span>Order</span>}
          <span className="flex items-center gap-1">
            Value (as stored) <FieldHelp id="value_value" />
          </span>
          <span className="flex items-center gap-1">
            Label <FieldHelp id="value_label" />
          </span>
          <span className="flex items-center gap-1">
            Synonyms (comma-separated) <FieldHelp id="value_synonyms" />
          </span>
          <span className="flex items-center gap-1">
            Rows <FieldHelp id="value_count" />
          </span>
          <span />
          <span />
        </div>
      )}
      {rows.map((row, i) => {
        const sug = suggestions[row.id];
        return (
          <div key={row.id} className={`grid ${cols} items-center gap-1`}>
            {ordered && (
              <div className="flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${row.value || "row"} up`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => move(i, 1)}
                  disabled={i === rows.length - 1}
                  aria-label={`Move ${row.value || "row"} down`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            <Input
              value={row.value}
              onChange={(e) => setCell(i, "value", e.target.value)}
              placeholder="e.g. DONE"
              className={`h-8 font-mono text-xs placeholder:italic ${duplicates.has(row.value.trim()) ? "border-destructive" : ""}`}
            />
            <Input
              value={row.label}
              onChange={(e) => setCell(i, "label", e.target.value)}
              placeholder="e.g. Hoàn tất"
              className="h-8 text-xs placeholder:italic"
            />
            <Input
              value={row.synonyms}
              onChange={(e) => setCell(i, "synonyms", e.target.value)}
              placeholder="e.g. hoàn thành, completed"
              className="h-8 text-xs placeholder:italic"
            />
            <Input
              value={row.count}
              onChange={(e) => setCell(i, "count", e.target.value)}
              placeholder="—"
              className="h-8 text-xs"
              inputMode="numeric"
            />
            {suggest ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-primary/80 hover:text-primary"
                onClick={() => runSuggest(row)}
                disabled={sug?.loading || !row.value.trim()}
                aria-label={`Suggest label and synonyms for ${row.value || "this value"} with AI`}
                title={
                  row.value.trim()
                    ? "Suggest the label and synonyms with AI (you can edit or undo before saving)"
                    : "Type the value first"
                }
              >
                {sug?.loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => {
                setSuggestion(row.id, null);
                update(rows.filter((_, j) => j !== i));
              }}
              aria-label={`Remove ${row.value || "row"}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            {sug?.error && (
              <p className="col-span-full text-xs text-destructive">
                {sug.error}{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setSuggestion(row.id, null)}
                >
                  Dismiss
                </button>
              </p>
            )}
            {sug?.confidence && (
              <p className="col-span-full flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Sparkles className="h-3 w-3" /> AI suggestion for {row.value}
                  , {CONFIDENCE_LABEL[sug.confidence]}
                </span>
                {sug.note && (
                  <span className="text-amber-700 dark:text-amber-400">
                    {sug.note}
                  </span>
                )}
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => undoSuggest(row)}
                >
                  Undo
                </button>
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => setSuggestion(row.id, null)}
                >
                  OK
                </button>
              </p>
            )}
          </div>
        );
      })}
      {duplicates.size > 0 && (
        <p className="text-xs text-destructive">
          Each value can appear only once.
        </p>
      )}

      {pasting && (
        <div className="flex flex-col gap-2 rounded-md border p-2">
          <p className="text-xs text-muted-foreground">
            {pasting === "values"
              ? "One value per line, exactly as stored. Labels and synonyms can be added after."
              : "One value per line. Columns separated by Tab (as copied from any table): value, label, synonyms, rows. Only the value is required."}{" "}
            Blank lines, repeats and values already in the list are skipped.
          </p>
          <Textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={pasting === "values" ? 8 : 5}
            className="font-mono text-xs"
            placeholder={pasting === "values" ? "DONE\nPENDING\nCANCELLED" : "DONE\tHoàn tất\thoàn thành, completed\t16900000"}
            autoFocus
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={addPasted} disabled={toAdd.length === 0}>
              Add {toAdd.length || ""} {toAdd.length === 1 ? "value" : "values"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setPasting(null);
                setPasteText("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            update([
              ...rows,
              {
                id: newRowId(),
                value: "",
                label: "",
                synonyms: "",
                count: "",
              },
            ])
          }
        >
          <Plus className="mr-1 h-4 w-4" />
          Add value
        </Button>
        {booleanPreset && !rows.some((r) => r.value.trim()) && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              update([
                { id: newRowId(), value: "true", label: "Có", synonyms: "true, yes", count: "" },
                { id: newRowId(), value: "false", label: "Không", synonyms: "false, no", count: "" },
              ])
            }
          >
            Add true / false
          </Button>
        )}
        {!pasting && (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setPasting("values")}>
              <ListPlus className="mr-1 h-4 w-4" />
              Paste values
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setPasting("table")}>
              <ClipboardPaste className="mr-1 h-4 w-4" />
              Paste a table
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
