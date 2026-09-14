// Skills dialog (docs/skill-transfer-plan.md, giai đoạn 2): the user's own
// skills — add, edit, delete — plus a read-only list of built-in ones. Saving
// goes through services/gateway, which also pushes the files into every open
// chat of this user, so a change applies from the next message.

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { translateErrorCode, useLocale } from "../../../i18n/locale.tsx";
import {
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  PlusIcon,
  SkillIcon,
  TrashIcon,
} from "../../../icons.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
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

export function SkillsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
    if (!window.confirm(t("skills.deleteConfirm", { name }))) return;
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
    if (open) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      if (expanded) setExpanded(false);
      else onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, expanded, onClose]);

  if (!open) return null;

  const builtin = menu.filter((item) => item.source === "builtin");
  const builtinSelected =
    selection.kind === "builtin" ? builtin.find((item) => item.name === selection.name) : undefined;

  return (
    <div className="fh-settings-dialog">
      <div className="fh-settings-mask" onClick={onClose} />
      <div className="fh-settings-panel fh-skills-panel" role="dialog" aria-label={t("skills.title")}>
        <div className="fh-settings-panel-header">
          <h2>{t("skills.title")}</h2>
          <IconButton variant="plain" className="fh-settings-close" onClick={onClose}>
            <CloseIcon size={14} />
          </IconButton>
        </div>
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
                  <Button variant="link" onClick={() => setExpanded(!expanded)}>
                    {expanded ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
                    {expanded ? t("skills.collapse") : t("skills.expand")}
                  </Button>
                </span>
                <textarea
                  className="fh-skills-textarea"
                  spellCheck={false}
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                />
              </div>

              <div className="fh-skills-actions">
                {selection.kind === "custom" && (
                  <Button variant="outline" onClick={() => void remove()} disabled={saving}>
                    <TrashIcon size={14} />
                    {t("skills.delete")}
                  </Button>
                )}
                <Button variant="primary" onClick={() => void save()} disabled={saving}>
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
