// Copied from bot-data-studio-web-main/src/components/profile/ai-suggest.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { suggestProfileField } from "@/lib/api";
import type {
  FieldSuggestion,
  SuggestField,
  SuggestionConfidence,
} from "@/lib/types";

const CONFIDENCE_LABEL: Record<SuggestionConfidence, string> = {
  high: "confident",
  medium: "a guess",
  low: "unsure — please check",
};

interface Options {
  /** table/column fields: which entity and target to ask about */
  entityId?: string;
  target?: "table" | "column";
  field: SuggestField;
  columnId?: string;
  /** the form's current values, sent as context */
  getDraft: () => Record<string, unknown>;
  value: string;
  setValue: (value: string) => void;
  /** other forms (e.g. metrics): how to ask for the suggestion */
  request?: (draft: Record<string, unknown>) => Promise<FieldSuggestion>;
  /** how to turn the answer into the field's text; default replaces the value */
  toValue?: (suggestion: FieldSuggestion, current: string) => string;
}

function defaultValue(field: SuggestField, s: FieldSuggestion): string {
  return field === "synonyms" ? (s.synonyms ?? []).join(", ") : (s.value ?? "");
}

export interface FieldSuggestionState {
  run: () => void;
  undo: () => void;
  dismiss: () => void;
  loading: boolean;
  error: string | null;
  result: {
    confidence: SuggestionConfidence;
    note: string | null;
    previous: string;
  } | null;
}

/** Ask the AI for one field and put the answer in the form (not saved until the form is saved). */
export function useFieldSuggestion({
  entityId,
  target,
  field,
  columnId,
  getDraft,
  value,
  setValue,
  request,
  toValue,
}: Options): FieldSuggestionState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FieldSuggestionState["result"]>(null);

  async function run() {
    setLoading(true);
    setError(null);
    const previous = value;
    try {
      const draft = getDraft();
      const s = request
        ? await request(draft)
        : await suggestProfileField(entityId ?? "", {
            target: target ?? "table",
            field,
            column_id: columnId ?? null,
            draft,
          });
      setValue(toValue ? toValue(s, previous) : defaultValue(field, s));
      setResult({ confidence: s.confidence, note: s.note, previous });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "The AI could not suggest this field",
      );
    } finally {
      setLoading(false);
    }
  }

  return {
    run,
    undo: () => {
      if (result) setValue(result.previous);
      setResult(null);
    },
    dismiss: () => {
      setResult(null);
      setError(null);
    },
    loading,
    error,
    result,
  };
}

/** The ✨ button placed next to a field's label. */
export function SuggestButton({
  s,
  label,
}: {
  s: FieldSuggestionState;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={s.run}
      disabled={s.loading}
      className="inline-flex shrink-0 items-center rounded-full text-primary/80 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      aria-label={`Suggest ${label} with AI`}
      title={`Suggest ${label} with AI (fills the field; you can edit or undo before saving)`}
    >
      {s.loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Sparkles className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/** A one-line note under the field after a suggestion: confidence, what to check, Undo. */
export function SuggestNote({ s }: { s: FieldSuggestionState }) {
  if (s.error) {
    return (
      <p className="text-xs text-destructive">
        {s.error}{" "}
        <button type="button" className="underline" onClick={s.dismiss}>
          Dismiss
        </button>
      </p>
    );
  }
  if (!s.result) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Sparkles className="h-3 w-3" /> AI suggestion,{" "}
        {CONFIDENCE_LABEL[s.result.confidence]}
      </span>
      {s.result.note && (
        <span className="text-amber-700 dark:text-amber-400">
          {s.result.note}
        </span>
      )}
      <button
        type="button"
        className="underline hover:text-foreground"
        onClick={s.undo}
      >
        Undo
      </button>
      <button
        type="button"
        className="underline hover:text-foreground"
        onClick={s.dismiss}
      >
        OK
      </button>
    </p>
  );
}
