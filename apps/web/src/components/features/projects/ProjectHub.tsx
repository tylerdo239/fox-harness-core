// Data-analysis project hub (docs/rlm-transfer-plan.md 9.1), shown in the
// center column by the sidebar's "Phân tích dữ liệu" entry. Layout and
// features follow agent-core's packages/ui-projects/src/ProjectHub.tsx: a
// project list with search and create, and a project page with a new-chat
// composer and Chats / Sources / Outputs tabs (upload with progress, download,
// image preview, "Đưa vào dự án").
//
// A project folder's files, by path: `generated/<chatId>/…` is one chat's
// output, `outputs/…` an output shared in the project, anything else a source.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import {
  ArrowLeftIcon,
  FileOutputIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  MessageSquareIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ShareIcon,
  TrashIcon,
} from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
import { useRuntime } from "../../../runtime.ts";
import {
  fetchWorkspaceFile,
  formatSize,
  listWorkspaceFiles,
  MAX_UPLOAD_BYTES,
  type WorkspaceFile,
} from "../conversation/workspaceApi.ts";
import {
  createProject,
  deleteProject,
  listProjectChats,
  listProjects,
  PROJECT_NAME_MAX,
  promoteProjectOutput,
  renameProject,
  uploadProjectFile,
  type Project,
  type ProjectChat,
} from "./projectsApi.ts";

type Translate = (key: TranslationKey, params?: Record<string, string>) => string;

const DATASET_RE = /\.(csv|tsv|xlsx?|parquet)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

function dateLabel(value: string, t: Translate): string {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? t("projects.today")
    : date.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function ProjectHub({
  projectId,
  onOpenProject,
  onStartChat,
}: {
  // null = the project list.
  projectId: string | null;
  onOpenProject: (projectId: string | null) => void;
  onStartChat: (projectId: string, firstMessage: string) => void;
}) {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [projects, setProjects] = useState<Project[] | undefined>();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    listProjects(runtime)
      .then(setProjects)
      .catch(() => {
        setProjects([]);
        toast.error(t("projects.loadFailed"));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(
    () => (projects ?? []).filter((project) => project.name.toLowerCase().includes(query.trim().toLowerCase())),
    [projects, query],
  );

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const created = await createProject(runtime, trimmed);
      onOpenProject(created.projectId);
    } catch {
      toast.error(t("projects.saveFailed"));
    }
  }

  if (projectId) {
    const project = projects?.find((item) => item.projectId === projectId);
    if (!projects) return <div className="fh-hub-scroll" />;
    if (!project) {
      return (
        <div className="fh-hub-scroll">
          <section className="fh-hub">
            <div className="fh-hub-empty">{t("projects.loadFailed")}</div>
          </section>
        </div>
      );
    }
    return <ProjectPage project={project} onBack={() => onOpenProject(null)} onStartChat={onStartChat} />;
  }

  return (
    <div className="fh-hub-scroll">
      <section className="fh-hub" aria-label={t("projects.title")}>
        <div className="fh-hub-hero">
          <div>
            <p className="fh-hub-eyebrow">{t("projects.eyebrow")}</p>
            <h1>{t("projects.title")}</h1>
          </div>
          <div className="fh-hub-actions">
            <label className="fh-hub-search">
              <SearchIcon size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("projects.search")} />
            </label>
            <button type="button" className="fh-hub-pill fh-hub-pill-primary fh-hub-create-open" onClick={() => setCreating(true)}>
              <PlusIcon size={17} />
              {t("projects.create")}
            </button>
          </div>
        </div>
        {creating && (
          <form className="fh-hub-create" onSubmit={(event) => void create(event)}>
            <input
              autoFocus
              value={name}
              maxLength={PROJECT_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("projects.newName")}
            />
            <button type="submit" className="fh-hub-pill fh-hub-pill-primary" disabled={!name.trim()}>
              {t("projects.createSubmit")}
            </button>
            <button type="button" className="fh-hub-pill" onClick={() => setCreating(false)}>
              {t("projects.cancel")}
            </button>
          </form>
        )}
        <div className="fh-hub-table-head">
          <span>{t("projects.colName")}</span>
          <span>{t("projects.colModified")}</span>
        </div>
        <div className="fh-hub-list">
          {visible.map((project) => (
            <button
              type="button"
              key={project.projectId}
              className="fh-hub-project-row"
              onClick={() => onOpenProject(project.projectId)}
            >
              <span className="fh-hub-project-name">
                <span className="fh-hub-folder">
                  <FolderIcon size={18} />
                </span>
                <span className="fh-hub-ellipsis">{project.name}</span>
              </span>
              <span>{dateLabel(project.updatedAt, t)}</span>
            </button>
          ))}
          {projects !== undefined && visible.length === 0 && <div className="fh-hub-empty">{t("projects.emptyList")}</div>}
        </div>
      </section>
    </div>
  );
}

function ProjectPage({
  project,
  onBack,
  onStartChat,
}: {
  project: Project;
  onBack: () => void;
  onStartChat: (projectId: string, firstMessage: string) => void;
}) {
  const runtime = useRuntime();
  const { t } = useLocale();
  const base = `/projects/${project.projectId}`;
  const [tab, setTab] = useState<"chats" | "sources" | "outputs">("chats");
  const [chats, setChats] = useState<ProjectChat[]>([]);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [title, setTitle] = useState(project.name);
  const [prompt, setPrompt] = useState("");
  const [progress, setProgress] = useState<number | undefined>();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function refresh(): Promise<void> {
    const [chatList, fileList] = await Promise.all([
      listProjectChats(runtime, project.projectId).catch(() => []),
      listWorkspaceFiles(runtime, base).catch(() => []),
    ]);
    setChats(chatList);
    setFiles(fileList ?? []);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sources = files.filter((file) => !file.path.startsWith("generated/") && !file.path.startsWith("outputs/"));
  const projectOutputs = files.filter((file) => file.path.startsWith("outputs/"));
  const chatOutputs = files
    .filter((file) => file.path.startsWith("generated/"))
    .map((file) => {
      const [, sessionId, ...rest] = file.path.split("/");
      return { file, sessionId, path: rest.join("/") };
    })
    .filter((output) => output.path);
  const chatTitle = (sessionId: string) =>
    chats.find((chat) => chat.sessionId === sessionId)?.title ?? t("historyChat.untitled", { id: sessionId.slice(0, 8) });

  async function upload(list: FileList | null): Promise<void> {
    const picked = Array.from(list ?? []);
    for (const [index, file] of picked.entries()) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(t("workspace.tooLarge", { name: file.name }));
        continue;
      }
      try {
        await uploadProjectFile(runtime, project.projectId, file, (fraction) =>
          setProgress(Math.round(((index + fraction) / picked.length) * 100)),
        );
        toast.success(t("workspace.uploaded", { name: file.name }));
      } catch {
        toast.error(t("workspace.uploadFailed", { name: file.name }));
      }
    }
    setProgress(undefined);
    await refresh();
  }

  async function openFile(path: string): Promise<void> {
    try {
      const url = URL.createObjectURL(await fetchWorkspaceFile(runtime, base, path));
      if (IMAGE_RE.test(path)) {
        setPreview({ path, url });
        return;
      }
      const link = document.createElement("a");
      link.href = url;
      link.download = path.split("/").pop() ?? path;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast.error(t("workspace.openFailed", { name: path }));
    }
  }

  function closePreview(): void {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  async function promote(sessionId: string, path: string): Promise<void> {
    try {
      await promoteProjectOutput(runtime, project.projectId, sessionId, path);
      toast.success(t("projects.promoted", { name: path.split("/").pop() ?? path }));
      await refresh();
    } catch {
      toast.error(t("projects.promoteFailed"));
    }
  }

  async function commitRename(): Promise<void> {
    const trimmed = renameValue.trim();
    setRenaming(false);
    if (!trimmed || trimmed === title) return;
    try {
      await renameProject(runtime, project.projectId, trimmed);
      setTitle(trimmed);
    } catch {
      toast.error(t("projects.saveFailed"));
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(t("projects.deleteConfirm", { name: title }))) return;
    try {
      await deleteProject(runtime, project.projectId);
      onBack();
    } catch {
      toast.error(t("projects.saveFailed"));
    }
  }

  const tabs = [
    { key: "chats", label: t("projects.tabChats"), count: chats.length },
    { key: "sources", label: t("projects.tabSources"), count: sources.length },
    { key: "outputs", label: t("projects.tabOutputs"), count: projectOutputs.length + chatOutputs.length },
  ] as const;

  return (
    <div className="fh-hub-scroll">
      <section className="fh-hub" aria-label={title}>
        <div className="fh-hub-header">
          <button type="button" className="fh-hub-icon-btn fh-hub-back" onClick={onBack} title={t("projects.back")} aria-label={t("projects.back")}>
            <ArrowLeftIcon size={18} />
          </button>
          <FolderIcon size={25} />
          {renaming ? (
            <input
              autoFocus
              className="fh-hub-title-input"
              value={renameValue}
              maxLength={PROJECT_NAME_MAX}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) void commitRename();
                else if (event.key === "Escape") setRenaming(false);
              }}
              onBlur={() => setRenaming(false)}
            />
          ) : (
            <h1>{title}</h1>
          )}
          <button
            type="button"
            className="fh-hub-icon-btn fh-hub-rename"
            title={t("projects.rename")}
            aria-label={t("projects.rename")}
            onClick={() => {
              setRenameValue(title);
              setRenaming(true);
            }}
          >
            <PencilIcon size={16} />
          </button>
          <button type="button" className="fh-hub-icon-btn fh-hub-delete" title={t("projects.delete")} aria-label={t("projects.delete")} onClick={() => void remove()}>
            <TrashIcon size={16} />
          </button>
        </div>

        <form
          className="fh-hub-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (prompt.trim()) onStartChat(project.projectId, prompt.trim());
          }}
        >
          <PlusIcon size={20} />
          <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("projects.composer", { name: title })} />
          <button type="submit" className="fh-hub-pill fh-hub-pill-primary" disabled={!prompt.trim()}>
            {t("projects.start")}
          </button>
        </form>

        <div className="fh-hub-tabs" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={`fh-hub-tab-${item.key}${tab === item.key ? " active" : ""}`}
              onClick={() => setTab(item.key)}
            >
              {item.label}
              <span>{item.count}</span>
            </button>
          ))}
        </div>

        {tab === "chats" && (
          <div className="fh-hub-list">
            {chats.map((chat) => (
              <button type="button" key={chat.sessionId} className="fh-hub-content-row" onClick={() => runtime.switchSession(chat.sessionId)}>
                <MessageSquareIcon size={18} />
                <span>
                  <strong>{chat.title ?? t("historyChat.untitled", { id: chat.sessionId.slice(0, 8) })}</strong>
                  <small>{dateLabel(chat.updatedAt, t)}</small>
                </span>
              </button>
            ))}
            {chats.length === 0 && <div className="fh-hub-empty">{t("projects.noChats")}</div>}
          </div>
        )}

        {tab === "sources" && (
          <div className="fh-hub-sources">
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void upload(event.target.files);
                event.target.value = "";
              }}
            />
            <button type="button" className="fh-hub-dropzone" onClick={() => inputRef.current?.click()} disabled={progress !== undefined}>
              <PaperclipIcon size={24} />
              <strong>{t("projects.dropTitle")}</strong>
              <span>{t("projects.dropHint")}</span>
              {progress !== undefined && (
                <span className="fh-hub-progress">
                  <i style={{ width: `${progress}%` }} />
                </span>
              )}
            </button>
            <div className="fh-hub-list">
              {sources.map((file) => {
                const dataset = DATASET_RE.test(file.path);
                const Icon = dataset ? FileSpreadsheetIcon : FileTextIcon;
                return (
                  <button type="button" key={file.path} className="fh-hub-content-row" onClick={() => void openFile(file.path)}>
                    <Icon size={18} />
                    <span>
                      <strong>{file.path}</strong>
                      <small>
                        {t(dataset ? "projects.sourceDataset" : "projects.sourceFile")} · {formatSize(file.sizeBytes)}
                      </small>
                    </span>
                  </button>
                );
              })}
              {sources.length === 0 && <div className="fh-hub-empty">{t("projects.noSources")}</div>}
            </div>
          </div>
        )}

        {tab === "outputs" && (
          <div className="fh-hub-outputs">
            <section className="fh-hub-output-group">
              <div className="fh-hub-output-heading">
                <div>
                  <h2>{t("projects.outputsProject")}</h2>
                  <p>{t("projects.outputsProjectHint")}</p>
                </div>
                <span>{projectOutputs.length}</span>
              </div>
              {projectOutputs.map((file) => (
                <div className="fh-hub-output-row" key={file.path}>
                  <button type="button" className="fh-hub-output-file" onClick={() => void openFile(file.path)}>
                    <FileOutputIcon size={18} />
                    <span>
                      <strong>{file.path.slice("outputs/".length)}</strong>
                      <small>
                        {t("projects.sharedInProject")} · {formatSize(file.sizeBytes)}
                      </small>
                    </span>
                  </button>
                </div>
              ))}
              {projectOutputs.length === 0 && <div className="fh-hub-empty">{t("projects.noOutputs")}</div>}
            </section>

            <section className="fh-hub-output-group">
              <div className="fh-hub-output-heading">
                <div>
                  <h2>{t("projects.outputsChats")}</h2>
                  <p>{t("projects.outputsChatsHint")}</p>
                </div>
                <span>{chatOutputs.length}</span>
              </div>
              {chatOutputs.map((output) => (
                <div className="fh-hub-output-row" key={output.file.path}>
                  <button type="button" className="fh-hub-output-file" onClick={() => void openFile(output.file.path)}>
                    <FileOutputIcon size={18} />
                    <span>
                      <strong>{output.path}</strong>
                      <small>
                        {chatTitle(output.sessionId)} · {formatSize(output.file.sizeBytes)}
                      </small>
                    </span>
                  </button>
                  <button type="button" className="fh-hub-promote" onClick={() => void promote(output.sessionId, output.path)}>
                    <ShareIcon size={15} />
                    {t("projects.promote")}
                  </button>
                </div>
              ))}
              {chatOutputs.length === 0 && <div className="fh-hub-empty">{t("projects.noOutputs")}</div>}
            </section>
          </div>
        )}
      </section>
      {preview && (
        <div className="fh-workspace-preview" role="dialog" onClick={closePreview}>
          <img src={preview.url} alt={preview.path} />
          <span>{preview.path}</span>
        </div>
      )}
    </div>
  );
}

// Above a chat that belongs to a project: a way back to that project's page
// (project chats are listed there, not in the sidebar history).
export function ProjectChatBar({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  const runtime = useRuntime();
  const [project, setProject] = useState<{ projectId: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let found = false;
    async function lookup(): Promise<void> {
      const res = await runtime.authedFetch("/sessions/mine");
      if (!res.ok || cancelled) return;
      const rows = (await res.json()) as { sessionId: string; projectId: string | null; projectName: string | null }[];
      const row = rows.find((item) => item.sessionId === runtime.sessionId);
      if (cancelled || !row?.projectId || !row.projectName) return;
      found = true;
      setProject({ projectId: row.projectId, name: row.projectName });
    }
    setProject(null);
    if (runtime.sessionId) void lookup();
    // A brand-new chat is listed only once its first message is in; look again
    // when a live turn starts. onFrame replays past frames on subscribe — skip those.
    let live = false;
    const unsubscribe = runtime.onFrame((frame) => {
      if (live && !found && frame.type === "event" && frame.event.type === "turn/start") void lookup();
    });
    live = true;
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.sessionId]);

  if (!project) return null;
  return (
    <div className="fh-chat-project-bar">
      <button type="button" onClick={() => onOpenProject(project.projectId)}>
        <ArrowLeftIcon size={14} />
        <FolderIcon size={14} />
        {project.name}
      </button>
    </div>
  );
}
