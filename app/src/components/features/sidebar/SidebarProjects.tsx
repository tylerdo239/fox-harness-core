// "Dự án" tree in the sidebar (2026-10-19, user screenshot): projects as
// folders with their chats nested under each one. Same data as the project
// hub — `/projects` plus `/sessions/mine` grouped by `projectId`.
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { ChevronDownIcon, FolderIcon, FolderOpenIcon, MoreIcon, PlusIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { createProject, listProjects, PROJECT_NAME_MAX, type Project } from "../projects/projectsApi.ts";

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
  const [projects, setProjects] = useState<Project[]>([]);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    listProjects(runtime).then(setProjects).catch(() => {});
    runtime
      .authedFetch("/sessions/mine")
      .then((res) => (res.ok ? (res.json() as Promise<ChatRow[]>) : []))
      .then(setChats)
      .catch(() => {});
  }, [runtime.sessionId, runtime.sessionsVersion]);

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
    <div className="fh-sidebar-projects">
      <div className="fh-sidebar-projects-head">
        <button type="button" className="fh-sidebar-projects-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t("projects.title")}
          <ChevronDownIcon size={14} style={open ? undefined : { transform: "rotate(-90deg)" }} />
        </button>
        <button type="button" className="fh-sidebar-projects-action" title={t("projects.all")} aria-label={t("projects.all")} onClick={() => onOpenProject(null)}>
          <MoreIcon size={16} />
        </button>
        <button type="button" className="fh-sidebar-projects-action" title={t("projects.newName")} aria-label={t("projects.newName")} onClick={() => { setOpen(true); setCreating(true); }}>
          <PlusIcon size={16} />
        </button>
      </div>
      {creating && (
        <form className="fh-sidebar-projects-create" onSubmit={(event) => void create(event)}>
          <input
            autoFocus
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
                className="fh-sidebar-project-name"
                aria-expanded={isOpen}
                onClick={() => setExpanded({ ...expanded, [project.projectId]: !isOpen })}
              >
                {isOpen ? <FolderOpenIcon size={16} /> : <FolderIcon size={16} />}
                <span>{project.name}</span>
              </button>
              {isOpen && own.map((chat) => (
                <div
                  key={chat.sessionId}
                  className={`fh-history-chat-row fh-sidebar-project-chat${chat.sessionId === runtime.sessionId ? " active" : ""}`}
                  onClick={() => chat.sessionId !== runtime.sessionId && runtime.switchSession(chat.sessionId, project.projectId)}
                >
                  <span className="fh-history-chat-row-title">
                    {chat.title ?? t("historyChat.untitled", { id: chat.sessionId.slice(0, 8) })}
                  </span>
                </div>
              ))}
              {isOpen && own.length === 0 && <div className="fh-sidebar-project-empty">{t("projects.sidebarNoChats")}</div>}
            </div>
          );
        })}
    </div>
  );
}
