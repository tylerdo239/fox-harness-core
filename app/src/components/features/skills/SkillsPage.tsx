// Skills page at /my-skills (docs/skill-transfer-plan.md, giai đoạn 2): the user's
// own skills — add, edit, delete — plus a read-only list of built-in ones.
// Saving goes through services/gateway, which also pushes the files into every
// open chat of this user, so a change applies from the next message.
// A page in the main column since 2026-10-28 (user: "khi mở kỹ năng đang là
// modal giờ hãy bỏ và thay bằng 1 tab trên screen chính"), was a dialog.

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { translateErrorCode, useLocale } from "../../../i18n/locale.tsx";
import {
  ArrowLeftIcon,
  CollapseIcon,
  ExpandIcon,
  PlusIcon,
  SkillIcon,
  TrashIcon,
} from "../../../icons.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { confirmDialog } from "../../primitives/ConfirmDialog.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";
import { MenuItem } from "../../primitives/MenuItem.tsx";
import { useSkillMenu } from "../conversation/SkillMenu.tsx";
import {
  createCustomSkill,
  deleteCustomSkill,
  listCustomSkills,
  refreshSkillMenu,
  SkillApiError,
  updateCustomSkill,
  type CustomSkill,
  type SkillInput,
} from "./skillsApi.ts";

type Selection =
  | { kind: "new" }
  | { kind: "custom"; name: string }
  | { kind: "builtin"; name: string };

const EMPTY_DRAFT: SkillInput = { name: "", description: "", content: "" };
const DESCRIPTION_MAX = 280;

export function SkillsPage({ onBack }: { onBack: () => void }) {
  const { t } = useLocale();
  const runtime = useRuntime();
  const menu = useSkillMenu(runtime);
  const [skills, setSkills] = useState<CustomSkill[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: "new" });
  const [draft, setDraft] = useState<SkillInput>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  function pick(next: Selection, list: CustomSkill[] = skills): void {
    setSelection(next);
    setExpanded(false);
    const skill = next.kind === "custom" ? list.find((s) => s.name === next.name) : undefined;
    setDraft(skill ? { name: skill.name, description: skill.description, content: skill.content } : EMPTY_DRAFT);
  }

  async function reload(select?: Selection): Promise<void> {
    try {
      const list = await listCustomSkills(runtime);
      setSkills(list);
      const fallback: Selection = list[0] ? { kind: "custom", name: list[0].name } : { kind: "new" };
      pick(select ?? fallback, list);
    } catch {
      toast.error(t("skills.loadFailed"));
    }
  }

  function showError(error: unknown): void {
    toast.error(
      error instanceof SkillApiError ? translateErrorCode(t, error.code, error.message) : String(error),
    );
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const saved =
        selection.kind === "custom"
          ? await updateCustomSkill(runtime, draft)
          : await createCustomSkill(runtime, draft);
      toast.success(t("skills.saved", { name: saved.name }));
      void refreshSkillMenu(runtime);
      await reload({ kind: "custom", name: saved.name });
    } catch (error) {
      showError(error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (selection.kind !== "custom") return;
    const name = selection.name;
    const ok = await confirmDialog({
      title: t("skills.deleteTitle"),
      message: t("skills.deleteConfirm", { name }),
      confirmLabel: t("skills.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteCustomSkill(runtime, name);
      toast.success(t("skills.deleted", { name }));
      void refreshSkillMenu(runtime);
      await reload({ kind: "new" });
    } catch (error) {
      showError(error);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape only shrinks the enlarged content editor back; leaving the page is the back button (or Back).
  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  // Save only does something once the form differs from what it was opened with (the saved skill, or an empty new
  // one); the unsaved note says so next to it.
  const saved = selection.kind === "custom" ? skills.find((s) => s.name === selection.name) : undefined;
  const baseline: SkillInput = saved ? { name: saved.name, description: saved.description, content: saved.content } : EMPTY_DRAFT;
  const dirty =
    draft.name !== baseline.name || draft.description !== baseline.description || draft.content !== baseline.content;

  const builtin = menu.filter((item) => item.source === "builtin");
  const builtinSelected =
    selection.kind === "builtin" ? builtin.find((item) => item.name === selection.name) : undefined;

  return (
    <div className="fh-skills-page">
      <header className="fh-usage-head">
        <button type="button" className="fh-usage-icon-btn" onClick={onBack} aria-label={t("usage.back")} title={t("usage.back")}>
          <ArrowLeftIcon size={18} />
        </button>
        <span className="fh-usage-head-icon"><SkillIcon size={20} /></span>
        <div className="fh-usage-head-text">
          <h1>{t("skills.title")}</h1>
          <p>{t("skills.subtitle")}</p>
        </div>
      </header>
      <div className="fh-skills-page-body">
        <div className="fh-settings-body">
          <div className="fh-settings-nav fh-skills-list">
            <MenuItem variant="nav" active={selection.kind === "new"} onClick={() => pick({ kind: "new" })}>
              <PlusIcon size={16} />
              {t("skills.new")}
            </MenuItem>

            <div className="fh-skills-list-title">{t("skills.mine")}</div>
            {skills.length === 0 && <div className="fh-skills-list-empty">{t("skills.emptyMine")}</div>}
            {skills.map((skill) => (
              <MenuItem
                key={skill.name}
                variant="nav"
                active={selection.kind === "custom" && selection.name === skill.name}
                onClick={() => pick({ kind: "custom", name: skill.name })}
              >
                <SkillIcon size={15} />
                <span className="fh-skills-item-name">{skill.name}</span>
              </MenuItem>
            ))}

            <div className="fh-skills-list-title">{t("skills.builtin")}</div>
            {builtin.map((skill) => (
              <MenuItem
                key={skill.name}
                variant="nav"
                active={selection.kind === "builtin" && selection.name === skill.name}
                onClick={() => pick({ kind: "builtin", name: skill.name })}
              >
                <SkillIcon size={15} />
                <span className="fh-skills-item-name">{skill.name}</span>
              </MenuItem>
            ))}
          </div>

          {builtinSelected ? (
            <div className="fh-skills-form">
              <h3 className="fh-skills-readonly-name">/{builtinSelected.name}</h3>
              <p className="fh-skills-readonly-desc">{builtinSelected.description}</p>
              <p className="fh-skills-field-hint">{t("skills.builtinReadonly", { name: builtinSelected.name })}</p>
            </div>
          ) : (
            <div className="fh-skills-form">
              <label className="fh-skills-field">
                <span className="fh-skills-field-label">{t("skills.name")}</span>
                <input
                  type="text"
                  value={draft.name}
                  disabled={selection.kind === "custom"}
                  placeholder={t("skills.namePlaceholder")}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value.toLowerCase().replace(/\s+/g, "-") })
                  }
                />
                <span className="fh-skills-field-hint">{t("skills.nameHint")}</span>
              </label>

              <label className="fh-skills-field">
                <span className="fh-skills-field-row">
                  <span className="fh-skills-field-label">{t("skills.description")}</span>
                  <span className="fh-skills-field-hint">
                    {draft.description.length}/{DESCRIPTION_MAX}
                  </span>
                </span>
                <textarea
                  className="fh-skills-textarea fh-skills-description"
                  rows={3}
                  maxLength={DESCRIPTION_MAX}
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>

              <div className={`fh-skills-field fh-skills-content${expanded ? " fh-skills-content-expanded" : ""}`}>
                <span className="fh-skills-field-row">
                  <span className="fh-skills-field-label">{t("skills.content")}</span>
                  <IconButton
                    variant="bordered"
                    onClick={() => setExpanded(!expanded)}
                    title={expanded ? t("skills.collapse") : t("skills.expand")}
                    aria-label={expanded ? t("skills.collapse") : t("skills.expand")}
                  >
                    {expanded ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
                  </IconButton>
                </span>
                <textarea
                  className="fh-skills-textarea"
                  spellCheck={false}
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                />
              </div>

              <div className="fh-skills-actions">
                {dirty && !saving && <span className="fh-skills-unsaved">{t("skills.unsaved")}</span>}
                {selection.kind === "custom" && (
                  <Button variant="outline" onClick={() => void remove()} disabled={saving}>
                    <TrashIcon size={14} />
                    {t("skills.delete")}
                  </Button>
                )}
                <Button variant="primary" onClick={() => void save()} disabled={saving || !dirty}>
                  {saving ? t("skills.saving") : t("skills.save")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
