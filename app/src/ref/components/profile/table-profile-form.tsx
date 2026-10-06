// Copied from bot-data-studio-web-main/src/components/profile/table-profile-form.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { FilterEditor } from "@/components/profile/filter-editor";
import { withJsonFields } from "@/lib/json-fields";
import {
  SuggestButton,
  SuggestNote,
  useFieldSuggestion,
} from "@/components/profile/ai-suggest";
import { FieldHelp, HelpLabel } from "@/components/profile/field-help";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { updateEntityProfile } from "@/lib/api";
import type { ProfileHelpKey } from "@/lib/profile-help";
import { useUnsavedWarning } from "@/lib/use-unsaved-warning";
import type {
  EntityProfile,
  EntityProfileDetail,
  ProfileColumn,
  TableKind,
  Trust,
} from "@/lib/types";

const NONE = "__none__";
const TABLE_KINDS: { value: TableKind; label: string }[] = [
  {
    value: "fact",
    label: "fact — events or transactions (orders, calls, payments)",
  },
  { value: "dim", label: "dim — lookup list (branches, customers, products)" },
  {
    value: "snapshot",
    label: "snapshot — state captured each day/month (stock, balance)",
  },
  { value: "scd2", label: "scd2 — lookup list that keeps history rows" },
];
const TRUST: { value: Trust; label: string }[] = [
  { value: "certified", label: "certified — checked, safe to report from" },
  { value: "raw", label: "raw — not checked, use with care" },
];
const TIME_ZONES = ["Asia/Ho_Chi_Minh", "UTC"];
const TIME_TYPES = ["DATE", "TIMESTAMP", "TIMESTAMPTZ", "DATETIME", "TIME"];
const TIMESTAMP_TYPES = ["TIMESTAMP", "TIMESTAMPTZ", "DATETIME"];

function textOrNull(text: string): string | null {
  return text.trim() || null;
}

function ColumnSelect({
  value,
  onChange,
  columns,
  placeholder,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  columns: ProfileColumn[];
  placeholder: string;
}) {
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>—</SelectItem>
        {columns.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.physical_name}{" "}
            <span className="text-muted-foreground">({c.data_type})</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Section({
  title,
  hint,
  help,
  children,
}: {
  title: string;
  hint?: string;
  help?: ProfileHelpKey;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          {title}
          {help && <FieldHelp id={help} />}
        </h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function TableProfileForm({
  detail,
  onSaved,
}: {
  detail: EntityProfileDetail;
  onSaved: (detail: EntityProfileDetail) => void;
}) {
  const { entity, columns } = detail;
  const initial = detail.profile;

  const [displayName, setDisplayName] = useState(entity.display_name);
  const [description, setDescription] = useState(entity.description ?? "");
  const [synonyms, setSynonyms] = useState(entity.synonyms.join(", "));
  const [grain, setGrain] = useState(entity.grain_description ?? "");

  // the form's unsaved values, sent as context with every AI suggestion
  const draft = () => ({
    display_name: displayName,
    description,
    synonyms: synonyms
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    grain_description: grain,
  });
  const suggestName = useFieldSuggestion({
    entityId: entity.id,
    target: "table",
    field: "display_name",
    getDraft: draft,
    value: displayName,
    setValue: (v) => {
      setDisplayName(v);
      touch();
    },
  });
  const suggestSynonyms = useFieldSuggestion({
    entityId: entity.id,
    target: "table",
    field: "synonyms",
    getDraft: draft,
    value: synonyms,
    setValue: (v) => {
      setSynonyms(v);
      touch();
    },
  });
  const suggestDescription = useFieldSuggestion({
    entityId: entity.id,
    target: "table",
    field: "description",
    getDraft: draft,
    value: description,
    setValue: (v) => {
      setDescription(v);
      touch();
    },
  });
  const suggestGrain = useFieldSuggestion({
    entityId: entity.id,
    target: "table",
    field: "grain_description",
    getDraft: draft,
    value: grain,
    setValue: (v) => {
      setGrain(v);
      touch();
    },
  });
  const [isExposed, setIsExposed] = useState(entity.is_exposed);
  const [profile, setProfile] = useState<EntityProfile>(initial);
  const [caveats, setCaveats] = useState(initial.caveats.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty);

  // structure fields: the AI picks from the allowed options and this table's columns (names sent as context)
  const columnName = (id: string | null | undefined) => columns.find((c) => c.id === id)?.physical_name ?? "";
  const structureDraft = () => ({
    ...draft(),
    table_kind: profile.table_kind ?? undefined,
    trust: profile.trust ?? undefined,
    label_column: columnName(profile.label_column_id) || undefined,
    grain_keys: profile.grain_key_column_ids.map(columnName).filter(Boolean),
  });
  const suggestKind = useFieldSuggestion({
    entityId: entity.id,
    target: "table",
    field: "table_kind",
    getDraft: structureDraft,
    value: profile.table_kind ?? "",
    setValue: (v) => set("table_kind", v ? (v as TableKind) : null),
  });
  const suggestTrust = useFieldSuggestion({
    entityId: entity.id,
    target: "table",
    field: "trust",
    getDraft: structureDraft,
    value: profile.trust ?? "",
    setValue: (v) => set("trust", v ? (v as Trust) : null),
  });
  const suggestLabel = useFieldSuggestion({
    entityId: entity.id,
    target: "table",
    field: "label_column",
    getDraft: structureDraft,
    value: profile.label_column_id ?? "",
    setValue: (v) => set("label_column_id", v || null),
  });
  const suggestKeys = useFieldSuggestion({
    entityId: entity.id,
    target: "table",
    field: "grain_keys",
    getDraft: structureDraft,
    value: profile.grain_key_column_ids.join(","),
    setValue: (v) => set("grain_key_column_ids", v ? v.split(",") : []),
    toValue: (s) => (s.column_ids ?? []).join(","),
  });

  // filters can also use declared JSON fields (config.is_intent_node…)
  const filterColumns = useMemo(() => withJsonFields(columns), [columns]);
  const timeColumns = useMemo(
    () => columns.filter((c) => TIME_TYPES.includes(c.data_type.toUpperCase())),
    [columns],
  );

  function set<K extends keyof EntityProfile>(key: K, value: EntityProfile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
    touch();
  }

  function touch() {
    setSavedAt(null);
    setDirty(true);
  }

  function toggleGrainKey(id: string, checked: boolean) {
    set(
      "grain_key_column_ids",
      checked
        ? [...profile.grain_key_column_ids, id]
        : profile.grain_key_column_ids.filter((c) => c !== id),
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const detailAfter = await updateEntityProfile(entity.id, {
        display_name: displayName.trim() || entity.physical_name,
        description: textOrNull(description),
        synonyms: synonyms
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        grain_description: textOrNull(grain),
        is_exposed: isExposed,
        is_pii: entity.is_pii,
        profile: {
          ...profile,
          storage_tz: textOrNull(profile.storage_tz ?? ""),
          business_tz: textOrNull(profile.business_tz ?? ""),
          caveats: caveats
            .split("\n")
            .map((c) => c.trim())
            .filter(Boolean),
        },
      });
      onSaved(detailAfter);
      setSavedAt(new Date());
      setDirty(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save table profile",
      );
    } finally {
      setSaving(false);
    }
  }

  const isSnapshot = profile.table_kind === "snapshot";
  // the same conditions as the backend checklist (src/data_profile/checklist.py)
  const timeColumn = columns.find((c) => c.id === profile.time_column_id);
  const req = {
    label: profile.table_kind === "dim" || profile.table_kind === "scd2",
    time: profile.table_kind === "fact" || profile.table_kind === "snapshot",
    snapshot: isSnapshot,
    businessTz: !!profile.time_column_id,
    storageTz:
      !!timeColumn &&
      TIMESTAMP_TYPES.includes(timeColumn.data_type.toUpperCase()),
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-baseline justify-between gap-2 text-lg">
          Table
          <span className="text-xs font-normal text-muted-foreground">
            <span className="text-destructive">*</span> required
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Section title="What the table is">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <HelpLabel
                help="table_display_name"
                htmlFor="tp_name"
                action={
                  <SuggestButton s={suggestName} label="the display name" />
                }
              >
                Display name
              </HelpLabel>
              <Input
                id="tp_name"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  touch();
                }}
              />
              <SuggestNote s={suggestName} />
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel
                help="table_synonyms"
                htmlFor="tp_syn"
                action={
                  <SuggestButton s={suggestSynonyms} label="other names" />
                }
              >
                Other names (comma-separated)
              </HelpLabel>
              <Input
                id="tp_syn"
                value={synonyms}
                onChange={(e) => {
                  setSynonyms(e.target.value);
                  touch();
                }}
                placeholder="đơn hàng, hóa đơn"
              />
              <SuggestNote s={suggestSynonyms} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel
              help="table_description"
              required
              htmlFor="tp_desc"
              action={
                <SuggestButton s={suggestDescription} label="the description" />
              }
            >
              Description
            </HelpLabel>
            <Textarea
              id="tp_desc"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                touch();
              }}
              rows={2}
              placeholder="What it contains and which questions it answers"
            />
            <SuggestNote s={suggestDescription} />
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel
              help="grain_description"
              required
              htmlFor="tp_grain"
              action={
                <SuggestButton s={suggestGrain} label="what one row is" />
              }
            >
              One row is…
            </HelpLabel>
            <Input
              id="tp_grain"
              value={grain}
              onChange={(e) => {
                setGrain(e.target.value);
                touch();
              }}
              placeholder="1 row = 1 order"
            />
            <SuggestNote s={suggestGrain} />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2 md:w-1/2">
            <HelpLabel help="table_visible" htmlFor="tp_exposed">
              Visible to the agent
            </HelpLabel>
            <Switch
              id="tp_exposed"
              checked={isExposed}
              onCheckedChange={(v) => {
                setIsExposed(v);
                touch();
              }}
            />
          </div>
        </Section>

        <Section title="Structure">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="table_kind" required action={<SuggestButton s={suggestKind} label="the table kind" />}>
                Table kind
              </HelpLabel>
              <Select
                value={profile.table_kind ?? NONE}
                onValueChange={(v) =>
                  set("table_kind", v === NONE ? null : (v as TableKind))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>—</SelectItem>
                  {TABLE_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <SuggestNote s={suggestKind} />
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="trust" required action={<SuggestButton s={suggestTrust} label="the trust level" />}>
                Trust
              </HelpLabel>
              <Select
                value={profile.trust ?? NONE}
                onValueChange={(v) =>
                  set("trust", v === NONE ? null : (v as Trust))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>—</SelectItem>
                  {TRUST.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <SuggestNote s={suggestTrust} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5 md:w-1/2">
            <HelpLabel help="label_column" required={req.label} action={<SuggestButton s={suggestLabel} label="the label column" />}>
              Label column
            </HelpLabel>
            <ColumnSelect
              value={profile.label_column_id}
              onChange={(v) => set("label_column_id", v)}
              columns={columns}
              placeholder="—"
            />
            <span className="text-xs text-muted-foreground">
              The column that names a row, shown instead of the id (e.g.
              agent_name for agent_id)
            </span>
            <SuggestNote s={suggestLabel} />
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="grain_keys" required action={<SuggestButton s={suggestKeys} label="the columns that identify one row" />}>
              Columns that identify one row
            </HelpLabel>
            <div className="grid max-h-48 grid-cols-2 gap-x-4 gap-y-1.5 overflow-y-auto rounded-md border p-3 md:grid-cols-3">
              {columns.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={profile.grain_key_column_ids.includes(c.id)}
                    onCheckedChange={(checked) =>
                      toggleGrainKey(c.id, checked === true)
                    }
                  />
                  <span className="truncate font-mono text-xs">
                    {c.physical_name}
                  </span>
                </label>
              ))}
            </div>
            <SuggestNote s={suggestKeys} />
          </div>
        </Section>

        <Section
          title="Time"
          hint="Which column dates a row, and how days and months are counted"
        >
          <div className="grid gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="time_column" required={req.time}>
                Main date/time column
              </HelpLabel>
              <ColumnSelect
                value={profile.time_column_id}
                onChange={(v) => set("time_column_id", v)}
                columns={timeColumns.length ? timeColumns : columns}
                placeholder="—"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel
                help="business_tz"
                required={req.businessTz}
                htmlFor="tp_btz"
              >
                Business time zone
              </HelpLabel>
              <Input
                id="tp_btz"
                list="tz-options"
                value={profile.business_tz ?? ""}
                onChange={(e) => set("business_tz", e.target.value)}
                placeholder="Asia/Ho_Chi_Minh"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel
                help="storage_tz"
                required={req.storageTz}
                htmlFor="tp_stz"
              >
                Stored in time zone
              </HelpLabel>
              <Input
                id="tp_stz"
                list="tz-options"
                value={profile.storage_tz ?? ""}
                onChange={(e) => set("storage_tz", e.target.value)}
                placeholder="UTC"
              />
            </div>
            <datalist id="tz-options">
              {TIME_ZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </div>
          {isSnapshot && (
            <div className="flex flex-col gap-1.5 md:w-1/3">
              <HelpLabel help="snapshot_column" required={req.snapshot}>
                Snapshot date column
              </HelpLabel>
              <ColumnSelect
                value={profile.snapshot_column_id}
                onChange={(v) => set("snapshot_column_id", v)}
                columns={timeColumns.length ? timeColumns : columns}
                placeholder="—"
              />
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="coverage_start" htmlFor="tp_cs">
                Data starts on
              </HelpLabel>
              <Input
                id="tp_cs"
                type="date"
                value={profile.coverage_start ?? ""}
                onChange={(e) =>
                  set("coverage_start", textOrNull(e.target.value))
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="coverage_end" htmlFor="tp_ce">
                Data ends on (empty = ongoing)
              </HelpLabel>
              <Input
                id="tp_ce"
                type="date"
                value={profile.coverage_end ?? ""}
                onChange={(e) =>
                  set("coverage_end", textOrNull(e.target.value))
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <HelpLabel help="coverage_gaps" htmlFor="tp_gaps">
                Periods with missing data
              </HelpLabel>
              <Input
                id="tp_gaps"
                value={profile.coverage_gaps ?? ""}
                onChange={(e) =>
                  set("coverage_gaps", textOrNull(e.target.value))
                }
                placeholder="10/02–14/02/2024 (POS offline during Tết)"
              />
            </div>
          </div>
        </Section>

        <Section
          title="Default filters"
          help="default_filters"
          hint="Rows are kept only when they match every condition here. These apply to every count and sum on this table. E.g. to exclude deleted rows: deleted_at is empty; to keep only completed orders: status = DONE."
        >
          <FilterEditor
            filters={profile.default_filters}
            columns={filterColumns}
            onChange={(f) => set("default_filters", f)}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={profile.default_filters_confirmed}
              onCheckedChange={(c) =>
                set("default_filters_confirmed", c === true)
              }
            />
            I checked the default filters
            {profile.default_filters.length === 0 ? " — none are needed" : ""}
            <FieldHelp id="default_filters_confirmed" />
          </label>
        </Section>

        <Section
          title="Filters for row lists"
          help="list_filters"
          hint="When listing individual rows, only rows matching every condition here are shown (usually lighter, e.g. only exclude test data)."
        >
          <FilterEditor
            filters={profile.list_filters}
            columns={filterColumns}
            onChange={(f) => set("list_filters", f)}
          />
        </Section>

        <Section title="Caveats and notes">
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="caveats" htmlFor="tp_caveats">
              Caveats (one per line — shown to users with answers)
            </HelpLabel>
            <Textarea
              id="tp_caveats"
              value={caveats}
              onChange={(e) => {
                setCaveats(e.target.value);
                touch();
              }}
              rows={3}
              placeholder="branch_id is empty for orders before 03/2024"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="table_notes" htmlFor="tp_notes">
              Notes for other curators
            </HelpLabel>
            <Textarea
              id="tp_notes"
              value={profile.notes ?? ""}
              onChange={(e) => set("notes", textOrNull(e.target.value))}
              rows={2}
            />
          </div>
        </Section>

        {error && (
          <p className="whitespace-pre-line text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="sticky bottom-0 -mx-6 -mb-6 flex items-center justify-end gap-3 border-t bg-card px-6 py-3">
          {savedAt && (
            <span className="text-sm text-muted-foreground">Saved</span>
          )}
          {dirty && (
            <span className="text-sm text-amber-700 dark:text-amber-400">
              Unsaved changes
            </span>
          )}
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save table
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
