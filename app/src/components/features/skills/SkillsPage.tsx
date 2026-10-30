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
    <div className="fh-skills-page [&>.fh-usage-head]:flex-none [&>.fh-usage-head]:m-0 [&>.fh-usage-head]:[padding:18px_24px] [&>.fh-usage-head]:[border-bottom:1px_solid_var(--border)] [&_.fh-skills-list]:[width:260px] [&_.fh-skills-list]:[padding:0.75em_0.75em_1em] [&_.fh-skills-form]:[padding:1.25em_1.75em] [&_.fh-skills-content-expanded]:[border-radius:0] [@media(max-width:720px)]:[&>.fh-usage-head]:[padding:14px_16px] [@media(max-width:720px)]:[&_.fh-settings-body]:flex-col [@media(max-width:720px)]:[&_.fh-skills-list]:[width:auto] [@media(max-width:720px)]:[&_.fh-skills-list]:[max-height:38%] [@media(max-width:720px)]:[&_.fh-skills-list]:[border-right:none] [@media(max-width:720px)]:[&_.fh-skills-list]:[border-bottom:1px_solid_var(--border)]">
      <header className="fh-usage-head flex items-center [gap:12px] [margin-bottom:18px]">
        <button type="button" className="fh-usage-icon-btn flex-none [width:34px] [height:34px] p-0 inline-flex items-center justify-center [border:1px_solid_var(--border)] [border-radius:999px] [background:var(--bg)] [color:var(--fg)] cursor-pointer [&:hover]:[background:var(--bg-hover)]" onClick={onBack} aria-label={t("usage.back")} title={t("usage.back")}>
          <ArrowLeftIcon size={18} />
        </button>
        <span className="fh-usage-head-icon flex-none [width:40px] [height:40px] [border-radius:12px] inline-flex items-center justify-center [background:color-mix(in_srgb,var(--accent)_14%,transparent)] [color:var(--accent-text)]"><SkillIcon size={20} /></span>
        <div className="fh-usage-head-text [&_h1]:m-0 [&_h1]:[font-size:1.3em] [&_h1]:[font-weight:650] [&_p]:[margin:2px_0_0] [&_p]:[color:var(--muted)] [&_p]:[font-size:0.9em]">
          <h1>{t("skills.title")}</h1>
          <p>{t("skills.subtitle")}</p>
        </div>
      </header>
      <div className="fh-skills-page-body [flex:1] min-h-0 flex">
        <div className="fh-settings-body [flex:1] flex min-h-0">
          <div className="fh-settings-nav flex-none [padding:0.75em] [border-right:1px_solid_var(--border)] flex flex-col [gap:2px] fh-skills-list [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:[width:8px] [&::-webkit-scrollbar-thumb]:[background:var(--border)] [&::-webkit-scrollbar-thumb]:[border-radius:999px] [&::-webkit-scrollbar-thumb:hover]:[background:var(--muted)] [&::-webkit-scrollbar-track]:[background:transparent] [width:240px] overflow-y-auto">
            <MenuItem variant="nav" active={selection.kind === "new"} onClick={() => pick({ kind: "new" })}>
              <PlusIcon size={16} />
              {t("skills.new")}
            </MenuItem>

            <div className="fh-skills-list-title [margin:1em_0.75em_0.35em] [font-size:0.75em] font-semibold [color:var(--muted)]">{t("skills.mine")}</div>
            {skills.length === 0 && <div className="fh-skills-list-empty [padding:0.25em_0.75em] [font-size:0.85em] [color:var(--muted)]">{t("skills.emptyMine")}</div>}
            {skills.map((skill) => (
              <MenuItem
                key={skill.name}
                variant="nav"
                active={selection.kind === "custom" && selection.name === skill.name}
                onClick={() => pick({ kind: "custom", name: skill.name })}
              >
                <SkillIcon size={15} />
                <span className="fh-skills-item-name min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{skill.name}</span>
              </MenuItem>
            ))}

            <div className="fh-skills-list-title [margin:1em_0.75em_0.35em] [font-size:0.75em] font-semibold [color:var(--muted)]">{t("skills.builtin")}</div>
            {builtin.map((skill) => (
              <MenuItem
                key={skill.name}
                variant="nav"
                active={selection.kind === "builtin" && selection.name === skill.name}
                onClick={() => pick({ kind: "builtin", name: skill.name })}
              >
                <SkillIcon size={15} />
                <span className="fh-skills-item-name min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{skill.name}</span>
              </MenuItem>
            ))}
          </div>

          {builtinSelected ? (
            <div className="fh-skills-form [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:[width:8px] [&::-webkit-scrollbar-thumb]:[background:var(--border)] [&::-webkit-scrollbar-thumb]:[border-radius:999px] [&::-webkit-scrollbar-thumb:hover]:[background:var(--muted)] [&::-webkit-scrollbar-track]:[background:transparent] relative [flex:1] min-w-0 flex flex-col [gap:1em] [padding:1em_1.25em] overflow-y-auto">
              <h3 className="fh-skills-readonly-name m-0 [font-size:1.1em]">/{builtinSelected.name}</h3>
              <p className="fh-skills-readonly-desc m-0 [line-height:1.6]">{builtinSelected.description}</p>
              <p className="fh-skills-field-hint [font-size:0.8em] [color:var(--muted)]">{t("skills.builtinReadonly", { name: builtinSelected.name })}</p>
            </div>
          ) : (
            <div className="fh-skills-form [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:[width:8px] [&::-webkit-scrollbar-thumb]:[background:var(--border)] [&::-webkit-scrollbar-thumb]:[border-radius:999px] [&::-webkit-scrollbar-thumb:hover]:[background:var(--muted)] [&::-webkit-scrollbar-track]:[background:transparent] relative [flex:1] min-w-0 flex flex-col [gap:1em] [padding:1em_1.25em] overflow-y-auto">
              <label className="fh-skills-field flex flex-col [gap:0.35em]">
                <span className="fh-skills-field-label [font-size:0.85em] font-semibold [color:var(--fg)]">{t("skills.name")}</span>
                <input
                  type="text"
                  value={draft.name}
                  disabled={selection.kind === "custom"}
                  placeholder={t("skills.namePlaceholder")}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value.toLowerCase().replace(/\s+/g, "-") })
                  }
                />
                <span className="fh-skills-field-hint [font-size:0.8em] [color:var(--muted)]">{t("skills.nameHint")}</span>
              </label>

              <label className="fh-skills-field flex flex-col [gap:0.35em]">
                <span className="fh-skills-field-row flex items-center justify-between">
                  <span className="fh-skills-field-label [font-size:0.85em] font-semibold [color:var(--fg)]">{t("skills.description")}</span>
                  <span className="fh-skills-field-hint [font-size:0.8em] [color:var(--muted)]">
                    {draft.description.length}/{DESCRIPTION_MAX}
                  </span>
                </span>
                <textarea
                  className="fh-skills-textarea [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:[width:8px] [&::-webkit-scrollbar-thumb]:[background:var(--border)] [&::-webkit-scrollbar-thumb]:[border-radius:999px] [&::-webkit-scrollbar-thumb:hover]:[background:var(--muted)] [&::-webkit-scrollbar-track]:[background:transparent] [padding:0.6em_0.7em] [border:1px_solid_var(--border)] [border-radius:8px] [background:var(--bg)] [color:var(--fg)] [&:focus]:[outline:none] [&:focus]:[border-color:var(--accent)] fh-skills-description [font:inherit] [resize:none]"
                  rows={3}
                  maxLength={DESCRIPTION_MAX}
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>

              <div className={`fh-skills-field flex flex-col [gap:0.35em] fh-skills-content [flex:1] [min-height:14em] [&_.fh-skills-textarea]:[flex:1] [&_.fh-skills-textarea]:[resize:none]${expanded ? " fh-skills-content-expanded absolute [inset:0] [z-index:2] [padding:1em_1.25em] [background:var(--bg)] [border-radius:0_0_24px_0]" : ""}`}>
                <span className="fh-skills-field-row flex items-center justify-between">
                  <span className="fh-skills-field-label [font-size:0.85em] font-semibold [color:var(--fg)]">{t("skills.content")}</span>
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
                  className="fh-skills-textarea [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:[width:8px] [&::-webkit-scrollbar-thumb]:[background:var(--border)] [&::-webkit-scrollbar-thumb]:[border-radius:999px] [&::-webkit-scrollbar-thumb:hover]:[background:var(--muted)] [&::-webkit-scrollbar-track]:[background:transparent] [font:13px/1.55_'Noto_Sans_Mono','DejaVu_Sans_Mono',ui-monospace,monospace] [padding:0.6em_0.7em] [border:1px_solid_var(--border)] [border-radius:8px] [background:var(--bg)] [color:var(--fg)] [resize:vertical] [&:focus]:[outline:none] [&:focus]:[border-color:var(--accent)]"
                  spellCheck={false}
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                />
              </div>

              <div className="fh-skills-actions flex justify-end items-center [gap:0.5em]">
                {dirty && !saving && <span className="fh-skills-unsaved [margin-right:auto] inline-flex items-center [gap:0.45em] [font-size:0.85em] [color:var(--muted)] [&::before]:[content:''] [&::before]:[width:7px] [&::before]:[height:7px] [&::before]:[border-radius:999px] [&::before]:[background:var(--accent)]">{t("skills.unsaved")}</span>}
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
