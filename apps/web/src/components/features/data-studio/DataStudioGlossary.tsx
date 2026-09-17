// docs/data-studio-admin-ui-plan.md — Glossary section (Phase 3, part 2).
// Flat CRUD against services/gateway's /data-studio/glossary routes — no
// Dremio dependency, unlike Data Sources. Same inline-edit-on-blur pattern
// DataStudioDataSources.tsx uses, plus a small "add term" form and a real
// delete action (that section has none, since entities/columns are synced,
// not manually created).
import { useCallback, useEffect, useState } from "react";

import { TrashIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";
import { Input } from "../../primitives/Input.tsx";

interface GlossaryTerm {
  id: number;
  term: string;
  synonyms: string;
  definition_text: string;
  sql_expressions: string;
  related_entity_ids: string;
}

function parseJsonArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

const EMPTY_DRAFT = { term: "", definition_text: "", synonyms: "" };

export function DataStudioGlossary() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await runtime.authedFetch("/data-studio/glossary");
    if (res.ok) setTerms(await res.json());
    setLoading(false);
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createTerm(): Promise<void> {
    if (!draft.term.trim() || !draft.definition_text.trim()) return;
    setSaving(true);
    const res = await runtime.authedFetch("/data-studio/glossary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        term: draft.term.trim(),
        definition_text: draft.definition_text.trim(),
        synonyms: draft.synonyms.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    });
    setSaving(false);
    if (res.ok) {
      setDraft(EMPTY_DRAFT);
      await load();
    }
  }

  async function saveTerm(term: GlossaryTerm, patch: Partial<GlossaryTerm>): Promise<void> {
    const body: Record<string, unknown> = { ...patch };
    if ("synonyms" in patch) body.synonyms = parseJsonArray(patch.synonyms as string);
    const res = await runtime.authedFetch(`/data-studio/glossary/${term.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) await load();
  }

  async function deleteTerm(term: GlossaryTerm): Promise<void> {
    const res = await runtime.authedFetch(`/data-studio/glossary/${term.id}`, { method: "DELETE" });
    if (res.ok) await load();
  }

  if (loading) return <div className="fh-data-studio-loading">{t("dataStudio.loading")}</div>;

  return (
    <div className="fh-data-studio-admin">
      <div className="fh-data-studio-admin-header">
        <h2>{t("dataStudio.sectionGlossary")}</h2>
      </div>

      <div className="fh-data-studio-add-form">
        <Input
          placeholder={t("dataStudio.termPlaceholder")}
          value={draft.term}
          onChange={(e) => setDraft((prev) => ({ ...prev, term: e.target.value }))}
        />
        <Input
          placeholder={t("dataStudio.definitionPlaceholder")}
          value={draft.definition_text}
          onChange={(e) => setDraft((prev) => ({ ...prev, definition_text: e.target.value }))}
        />
        <Input
          placeholder={t("dataStudio.synonymsPlaceholder")}
          value={draft.synonyms}
          onChange={(e) => setDraft((prev) => ({ ...prev, synonyms: e.target.value }))}
        />
        <Button variant="primary" onClick={createTerm} disabled={saving || !draft.term.trim() || !draft.definition_text.trim()}>
          {t("dataStudio.addTerm")}
        </Button>
      </div>

      <table className="fh-data-studio-table">
        <thead>
          <tr>
            <th>{t("dataStudio.colTerm")}</th>
            <th>{t("dataStudio.colDefinition")}</th>
            <th>{t("dataStudio.colSynonyms")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {terms.map((term) => (
            <tr key={term.id}>
              <td>
                <Input defaultValue={term.term} onBlur={(e) => e.target.value !== term.term && saveTerm(term, { term: e.target.value })} />
              </td>
              <td>
                <Input
                  defaultValue={term.definition_text}
                  onBlur={(e) => e.target.value !== term.definition_text && saveTerm(term, { definition_text: e.target.value })}
                />
              </td>
              <td>
                <Input
                  defaultValue={parseJsonArray(term.synonyms).join(", ")}
                  onBlur={(e) => saveTerm(term, { synonyms: JSON.stringify(e.target.value.split(",").map((s) => s.trim()).filter(Boolean)) })}
                />
              </td>
              <td>
                <IconButton onClick={() => deleteTerm(term)} title={t("dataStudio.deleteTerm")}>
                  <TrashIcon size={14} />
                </IconButton>
              </td>
            </tr>
          ))}
          {terms.length === 0 && (
            <tr>
              <td colSpan={4} className="fh-data-studio-empty">
                {t("dataStudio.noGlossaryTerms")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
