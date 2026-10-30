// "Dự án" tree in the sidebar (2026-10-19, user screenshot): projects as
// folders with their chats nested under each one. Same data as the project
// hub — `/projects` plus `/sessions/mine` grouped by `projectId`.
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { ChevronDownIcon, FolderIcon, FolderOpenIcon, MoreIcon, PlusIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { createProject, PROJECT_NAME_MAX, type Project } from "../projects/projectsApi.ts";
import { useMySessions, useProjects } from "../../../queries.ts";
import { Input } from "../../primitives/Input.tsx";

interface ChatRow {
  sessionId: string;
  title: string | null;
  projectId: string | null;
}

export function SidebarProjects({ onOpenProject }: { onOpenProject: (projectId: string | null) => void }) {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [open, setOpen] = useState(true);
  // collapsed by default; a click on a project shows its chats
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // shared with the history list and the project hub (src/queries.ts)
  const projects: Project[] = useProjects().data ?? [];
  const chats: ChatRow[] = useMySessions().data ?? [];
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    setCreating(false);
    setName("");
    if (!trimmed) return;
    try {
      const created = await createProject(runtime, trimmed);
      runtime.bumpSessionsVersion();
      onOpenProject(created.projectId);
    } catch {
      toast.error(t("projects.saveFailed"));
    }
  }

  return (
    <div className="fh-sidebar-projects [margin-bottom:8px]">
      <div className="fh-sidebar-projects-head flex items-center [gap:2px] [padding:6px_0.4em_4px_0.75em]">
        <button type="button" className="fh-sidebar-projects-toggle inline-flex items-center [height:28px] [border:0] [border-radius:6px] [background:transparent] [font:inherit] cursor-pointer p-0 [color:var(--muted)] [flex:1] [gap:4px] justify-start [&&]:[font-size:13px] [&&]:font-semibold" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t("projects.title")}
          <ChevronDownIcon size={14} style={open ? undefined : { transform: "rotate(-90deg)" }} />
        </button>
        <button type="button" className="fh-sidebar-projects-action inline-flex items-center [height:28px] [padding:0_4px] [border:0] [border-radius:6px] [background:transparent] [font:inherit] cursor-pointer [color:var(--muted)] justify-center [width:28px] [&:hover]:[background:var(--bg-hover)]" title={t("projects.all")} aria-label={t("projects.all")} onClick={() => onOpenProject(null)}>
          <MoreIcon size={16} />
        </button>
        <button type="button" className="fh-sidebar-projects-action inline-flex items-center [height:28px] [padding:0_4px] [border:0] [border-radius:6px] [background:transparent] [font:inherit] cursor-pointer [color:var(--muted)] justify-center [width:28px] [&:hover]:[background:var(--bg-hover)]" title={t("projects.newName")} aria-label={t("projects.newName")} onClick={() => { setOpen(true); setCreating(true); }}>
          <PlusIcon size={16} />
        </button>
      </div>
      {creating && (
        <form className="fh-sidebar-projects-create [padding:2px_0.4em_6px]" onSubmit={(event) => void create(event)}>
          <Input
            autoFocus
            type="text"
            className="fh-history-chat-search [input[type=text]&]:w-full [input[type=text]&]:[height:30px] [input[type=text]&]:[padding:0_0.6em] [input[type=text]&]:[border:1px_solid_var(--border)] [input[type=text]&:focus]:[border-color:var(--accent)] [input[type=text]&]:[border-radius:10px] [input[type=text]&]:[background:transparent] [input[type=text]&]:[color:var(--fg)] [input[type=text]&]:[font-size:0.85em]"
            value={name}
            maxLength={PROJECT_NAME_MAX}
            placeholder={t("projects.newName")}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setCreating(false)}
            onBlur={() => !name.trim() && setCreating(false)}
          />
        </form>
      )}
      {open && projects.map((project) => {
          const own = chats.filter((chat) => chat.projectId === project.projectId);
          const isOpen = expanded[project.projectId] ?? false;
          return (
            <div key={project.projectId} className="fh-sidebar-project">
              <button
                type="button"
                className="fh-sidebar-project-name inline-flex items-center [border:0] [border-radius:6px] [background:transparent] [color:var(--fg)] [font:inherit] cursor-pointer [&:hover]:[background:var(--bg-hover)] [height:34px] [padding:0_8px] [gap:8px] [width:calc(100%_-_0.8em)] [margin:0_0.4em] [&&]:[font-size:14px] [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap"
                aria-expanded={isOpen}
                onClick={() => setExpanded({ ...expanded, [project.projectId]: !isOpen })}
              >
                {isOpen ? <FolderOpenIcon size={16} /> : <FolderIcon size={16} />}
                <span>{project.name}</span>
              </button>
              {isOpen && own.map((chat) => (
                <div
                  key={chat.sessionId}
                  className={`fh-history-chat-row flex items-center [gap:6px] [height:32px] [padding:0_8px] [font-size:0.85em] cursor-pointer [border-radius:8px] [margin:0_0.4em] [transition:background_var(--duration-fast)_var(--ease)] [&:hover]:[background:var(--bg-hover)] [&&.active]:[background:var(--bg-hover)] [&.active_.fh-history-chat-row-title]:[color:var(--accent-text)] [&:hover_.fh-history-chat-row-menu-trigger]:inline-flex [&&.menu-open_.fh-history-chat-row-menu-trigger]:inline-flex fh-sidebar-project-chat [&&]:[padding-left:32px]${chat.sessionId === runtime.sessionId ? " active" : ""}`}
                  onClick={() => chat.sessionId !== runtime.sessionId && runtime.switchSession(chat.sessionId, project.projectId)}
                >
                  <span className="fh-history-chat-row-title [flex:1] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [color:var(--fg)] [font-size:14px] [line-height:20px]">
                    {chat.title ?? t("historyChat.untitled", { id: chat.sessionId.slice(0, 8) })}
                  </span>
                </div>
              ))}
              {isOpen && own.length === 0 && <div className="fh-sidebar-project-empty [padding:6px_0.4em_6px_calc(0.4em_+_32px)] [color:var(--muted)] [font-size:13px]">{t("projects.sidebarNoChats")}</div>}
            </div>
          );
        })}
    </div>
  );
}
