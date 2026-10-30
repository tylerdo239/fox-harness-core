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
import { confirmDialog } from "../../primitives/ConfirmDialog.tsx";

import {
  ArrowLeftIcon,
  FileOutputIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
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
import { MY_SESSIONS_KEY, queryClient, useMySessions, useProjects } from "../../../queries.ts";
import { showNoSpace, StorageFullError } from "../settings/storageApi.ts";
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
  // shared with the sidebar (src/queries.ts); undefined while the first load is in flight, [] once it failed
  const projectsQuery = useProjects();
  const projects: Project[] | undefined = projectsQuery.data ?? (projectsQuery.isError ? [] : undefined);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (projectsQuery.isError) toast.error(t("projects.loadFailed"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsQuery.isError]);

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
      runtime.bumpSessionsVersion();
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
          <section className="fh-hub box-border w-full [max-width:1040px] [margin:0_auto] [padding:34px_18px_56px] [color:var(--fg)] [&_h1]:m-0 [&_h1]:[font-size:30px] [&_h1]:[letter-spacing:-0.03em] [&_.fh-hub-folder]:[border:0] [&_.fh-hub-folder]:[background:color-mix(in_srgb,var(--accent)_14%,transparent)] [&_.fh-hub-folder]:[color:var(--accent-text)]">
            <div className="fh-hub-empty [padding:44px_12px] [color:var(--muted)] text-center">{t("projects.loadFailed")}</div>
          </section>
        </div>
      );
    }
    return <ProjectPage project={project} onBack={() => onOpenProject(null)} onStartChat={onStartChat} />;
  }

  return (
    <div className="fh-hub-scroll">
      <section className="fh-hub box-border w-full [max-width:1040px] [margin:0_auto] [padding:34px_18px_56px] [color:var(--fg)] [&_h1]:m-0 [&_h1]:[font-size:30px] [&_h1]:[letter-spacing:-0.03em] [&_.fh-hub-folder]:[border:0] [&_.fh-hub-folder]:[background:color-mix(in_srgb,var(--accent)_14%,transparent)] [&_.fh-hub-folder]:[color:var(--accent-text)]" aria-label={t("projects.title")}>
        <div className="fh-hub-hero flex items-end justify-between [gap:24px] [margin-bottom:34px] [@media(max-width:720px)]:flex-col [@media(max-width:720px)]:items-stretch">
          <div>
            <p className="fh-hub-eyebrow [margin:0_0_5px] [color:var(--muted)] [font-size:13px]">{t("projects.eyebrow")}</p>
            <h1>{t("projects.title")}</h1>
          </div>
          <div className="fh-hub-actions flex items-center [gap:12px] [@media(max-width:720px)]:items-stretch">
            <label className="fh-hub-search box-border flex items-center [gap:8px] [width:270px] [height:40px] [padding:0_14px] [border:1px_solid_var(--border)] [border-radius:999px] [background:var(--surface)] [color:var(--muted)] [&_input]:min-w-0 [&_input]:[flex:1] [&_input]:[border:0] [&_input]:[outline:0] [&_input]:[background:transparent] [&_input]:[color:var(--fg)] [&_input]:[font:inherit] [@media(max-width:720px)]:w-full">
              <SearchIcon size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("projects.search")} />
            </label>
            <button type="button" className="fh-hub-pill inline-flex items-center justify-center [gap:6px] [height:auto] [min-height:40px] [padding:0_17px] [border:1px_solid_var(--border)] [border-radius:999px] [font:inherit] [&&]:[font-weight:650] cursor-pointer [&:disabled]:[opacity:0.45] [&:disabled]:cursor-default fh-hub-pill-primary [background:var(--fh-accent-fill,#c84f0a)] [color:#fff] [&&]:[border-color:var(--fh-accent-fill,#c84f0a)] fh-hub-create-open" onClick={() => setCreating(true)}>
              <PlusIcon size={17} />
              {t("projects.create")}
            </button>
          </div>
        </div>
        {creating && (
          <form className="fh-hub-create [&_input]:min-w-0 [&_input]:[flex:1] [&_input]:[border:0] [&_input]:[outline:0] [&_input]:[background:transparent] [&_input]:[color:var(--fg)] [&_input]:[font:inherit] flex [gap:10px] [margin:-16px_0_24px] [padding:12px] [border:1px_solid_var(--border)] [border-radius:14px] [&_input]:[padding:0_10px]" onSubmit={(event) => void create(event)}>
            <input
              autoFocus
              value={name}
              maxLength={PROJECT_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("projects.newName")}
            />
            <button type="submit" className="fh-hub-pill inline-flex items-center justify-center [gap:6px] [height:auto] [min-height:40px] [padding:0_17px] [border:1px_solid_var(--border)] [border-radius:999px] [font:inherit] [&&]:[font-weight:650] cursor-pointer [&:disabled]:[opacity:0.45] [&:disabled]:cursor-default fh-hub-pill-primary [background:var(--fh-accent-fill,#c84f0a)] [color:#fff] [&&]:[border-color:var(--fh-accent-fill,#c84f0a)]" disabled={!name.trim()}>
              {t("projects.createSubmit")}
            </button>
            <button type="button" className="fh-hub-pill inline-flex items-center justify-center [gap:6px] [height:auto] [min-height:40px] [padding:0_17px] [border:1px_solid_var(--border)] [border-radius:999px] [background:transparent] [color:var(--fg)] [font:inherit] [&&]:[font-weight:650] cursor-pointer [&:disabled]:[opacity:0.45] [&:disabled]:cursor-default" onClick={() => setCreating(false)}>
              {t("projects.cancel")}
            </button>
          </form>
        )}
        <div className="fh-hub-table-head grid [grid-template-columns:1fr_210px] items-center text-left [padding:12px_12px] [border-bottom:1px_solid_var(--border)] [color:var(--muted)] [font-size:12px] [@media(max-width:720px)]:[grid-template-columns:1fr_100px]">
          <span>{t("projects.colName")}</span>
          <span>{t("projects.colModified")}</span>
        </div>
        <div className="fh-hub-list flex flex-col">
          {visible.map((project) => (
            <button
              type="button"
              key={project.projectId}
              className="fh-hub-project-row grid [grid-template-columns:1fr_210px] items-center text-left w-full [height:auto] [border:0] [&&]:[border-bottom:1px_solid_var(--border)] [border-radius:0] [background:transparent] [color:inherit] [font:inherit] cursor-pointer [padding:15px_12px] [&:hover]:[background:var(--bg-hover)] [@media(max-width:720px)]:[grid-template-columns:1fr_100px]"
              onClick={() => onOpenProject(project.projectId)}
            >
              <span className="fh-hub-project-name flex items-center [gap:12px] min-w-0 font-semibold">
                <span className="fh-hub-folder grid flex-none [place-items:center] [width:38px] [height:38px] [border:1px_solid_var(--border)] [border-radius:10px] [background:var(--surface)]">
                  <FolderIcon size={18} />
                </span>
                <span className="fh-hub-ellipsis overflow-hidden text-ellipsis whitespace-nowrap">{project.name}</span>
              </span>
              <span>{dateLabel(project.updatedAt, t)}</span>
            </button>
          ))}
          {projects !== undefined && visible.length === 0 && <div className="fh-hub-empty [padding:44px_12px] [color:var(--muted)] text-center">{t("projects.emptyList")}</div>}
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
  const [loaded, setLoaded] = useState(false);
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
    setLoaded(true);
    setFiles(fileList ?? []);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sources = files.filter((file) => file.origin === "source");
  const projectOutputs = files.filter((file) => file.origin === "shared");
  const chatOutputs = files.flatMap((file) =>
    file.origin === "chat" && file.sessionId
      ? [{ file, sessionId: file.sessionId, path: file.path.slice(`generated/${file.sessionId}/`.length) }]
      : [],
  );
  // Written by a model outside any chat's output folder, so the chat is unknown.
  const otherOutputs = files.filter((file) => file.origin === "chat" && !file.sessionId);
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
      } catch (error) {
        if (error instanceof StorageFullError) {
          // the rest would be refused too
          showNoSpace(error, t);
          break;
        }
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
      runtime.bumpSessionsVersion();
    } catch {
      toast.error(t("projects.saveFailed"));
    }
  }

  async function remove(): Promise<void> {
    const ok = await confirmDialog({
      title: t("projects.deleteTitle"),
      message: t("projects.deleteConfirm", { name: title }),
      confirmLabel: t("projects.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteProject(runtime, project.projectId);
      runtime.bumpSessionsVersion();
      onBack();
    } catch {
      toast.error(t("projects.saveFailed"));
    }
  }

  const tabs = [
    { key: "chats", label: t("projects.tabChats"), count: chats.length },
    { key: "sources", label: t("projects.tabSources"), count: sources.length },
    { key: "outputs", label: t("projects.tabOutputs"), count: projectOutputs.length + chatOutputs.length + otherOutputs.length },
  ] as const;

  const fresh = loaded && chats.length === 0;

  const titleNode = renaming ? (
    <input
      autoFocus
      className="fh-hub-title-input min-w-0 [flex:1] [border:0] [outline:0] [background:transparent] [color:var(--fg)] [font:inherit] [&&]:[font-size:30px] [&&]:font-bold"
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
  );

  const backButton = (
    <button type="button" className="fh-hub-icon-btn grid flex-none [place-items:center] [width:36px] [height:36px] p-0 [border:0] [border-radius:999px] [background:transparent] [color:var(--fg)] cursor-pointer [&:hover]:[background:var(--bg-hover)] fh-hub-back" onClick={onBack} title={t("projects.back")} aria-label={t("projects.back")}>
      <ArrowLeftIcon size={18} />
    </button>
  );

  const editButtons = (
    <>
      <button
        type="button"
        className="fh-hub-icon-btn grid flex-none [place-items:center] [width:36px] [height:36px] p-0 [border:0] [border-radius:999px] [background:transparent] [color:var(--fg)] cursor-pointer [&:hover]:[background:var(--bg-hover)] fh-hub-rename"
        title={t("projects.rename")}
        aria-label={t("projects.rename")}
        onClick={() => {
          setRenameValue(title);
          setRenaming(true);
        }}
      >
        <PencilIcon size={16} />
      </button>
      <button type="button" className="fh-hub-icon-btn grid flex-none [place-items:center] [width:36px] [height:36px] p-0 [border:0] [border-radius:999px] [background:transparent] [color:var(--fg)] cursor-pointer [&:hover]:[background:var(--bg-hover)] fh-hub-delete" title={t("projects.delete")} aria-label={t("projects.delete")} onClick={() => void remove()}>
        <TrashIcon size={16} />
      </button>
    </>
  );

  const dataChips = (
    <div className="fh-hub-data-chips [&&>span]:[color:var(--muted)] [&&>span]:[font-size:13px] flex flex-wrap items-center [gap:8px] [margin-bottom:16px]">
      {sources.length > 0 && <span>{t("projects.dataLabel")}</span>}
      {sources.map((file) => (
        <button type="button" key={file.path} className="fh-hub-data-chip inline-flex items-center [gap:8px] [height:34px] [padding:0_12px] [border:1px_solid_transparent] [border-radius:10px] [background:var(--surface)] [color:var(--fg)] [font:inherit] [&&]:[font-size:13px] cursor-pointer [&_small]:[color:var(--muted)] [&:hover]:[border-color:var(--accent)]" onClick={() => void openFile(file.path)}>
          <FileSpreadsheetIcon size={15} />
          <strong>{file.path}</strong>
          <small>{formatSize(file.sizeBytes)}</small>
        </button>
      ))}
      <button type="button" className="fh-hub-data-add inline-flex items-center [gap:8px] [height:34px] [padding:0_12px] [border-radius:10px] [font:inherit] [&&]:[font-size:13px] cursor-pointer [border:1px_dashed_var(--border)] [background:transparent] [color:var(--accent-text)] [&&]:font-semibold" onClick={() => inputRef.current?.click()} disabled={progress !== undefined}>
        <PlusIcon size={14} />
        {progress !== undefined ? `${progress}%` : t(sources.length > 0 ? "projects.addFile" : "projects.addDataFile")}
      </button>
    </div>
  );

  function submit(): void {
    if (prompt.trim()) onStartChat(project.projectId, prompt.trim());
  }

  // Composer redesign (2026-10-19 mockup): a big chat-style box — docked at
  // the bottom once the project has chats, centred while it has none.
  const composer = (
    <form
      className="fh-hub-ask flex flex-col [gap:6px] [padding:14px_12px_10px_18px] [border:1px_solid_var(--border)] [border-radius:20px] [background:var(--bg)] [box-shadow:var(--shadow-lv2)] [&:focus-within]:[border-color:var(--accent)] [&_textarea]:w-full [&_textarea]:[border:0] [&_textarea]:[outline:0] [&_textarea]:[resize:none] [&_textarea]:[background:transparent] [&_textarea]:[color:var(--fg)] [&_textarea]:[font:inherit] [&&_textarea]:[font-size:16px]"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        value={prompt}
        rows={fresh ? 3 : 2}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={t("projects.composer", { name: title })}
      />
      <div className="fh-hub-ask-bar flex items-center justify-between">
        <button type="button" className="fh-hub-ask-clip grid [place-items:center] [width:36px] [height:36px] p-0 [border:1px_solid_var(--border)] [border-radius:999px] [background:transparent] [color:var(--fg)] cursor-pointer [&:hover]:[background:var(--bg-hover)]" title={t("projects.addFile")} aria-label={t("projects.addFile")} onClick={() => inputRef.current?.click()}>
          <PaperclipIcon size={16} />
        </button>
        <button type="submit" className="fh-hub-pill inline-flex items-center justify-center [gap:6px] [height:auto] [min-height:40px] [padding:0_17px] [border:1px_solid_var(--border)] [border-radius:999px] [font:inherit] [&&]:[font-weight:650] cursor-pointer [&:disabled]:[opacity:0.45] [&:disabled]:cursor-default fh-hub-pill-primary [background:var(--fh-accent-fill,#c84f0a)] [color:#fff] [&&]:[border-color:var(--fh-accent-fill,#c84f0a)]" disabled={!prompt.trim()}>
          {t("projects.start")}
        </button>
      </div>
    </form>
  );

  return (
    <div className="fh-hub-page [&>.fh-hub-scroll]:[flex:1] [&>.fh-hub-scroll]:min-h-0 [&>.fh-hub-scroll]:overflow-y-auto">
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
      {fresh ? (
        <div className="fh-hub-fresh [&_.fh-hub-folder]:[border:0] [&_.fh-hub-folder]:[background:color-mix(in_srgb,var(--accent)_14%,transparent)] [&_.fh-hub-folder]:[color:var(--accent-text)] flex [flex:1] flex-col min-h-0 overflow-y-auto [padding:24px_28px]">
          <div className="fh-hub-fresh-top flex items-center [gap:4px]">
            {backButton}
            <span className="fh-hub-fresh-spacer [flex:1]" />
            {editButtons}
          </div>
          <section className="fh-hub-fresh-center [&>.fh-hub-ask]:box-border [&>.fh-hub-ask]:w-full [&>.fh-hub-ask]:[max-width:920px] [&>.fh-hub-ask]:[margin:0_auto] [&>small]:block [&>small]:[margin-top:8px] [&&>small]:[color:var(--muted)] [&&>small]:[font-size:12px] [&>small]:text-center flex [flex:1] flex-col items-center justify-center [gap:10px] [padding-bottom:80px] text-center [&_.fh-hub-folder]:[width:52px] [&_.fh-hub-folder]:[height:52px] [&_.fh-hub-folder]:[border-radius:14px] [&_h1]:m-0 [&&&_h1]:[font-size:24px] [&_p]:[margin:0_0_12px] [&_p]:[color:var(--muted)] [&_.fh-hub-data-chips]:justify-center [&_.fh-hub-data-chips]:[margin:8px_0_0]" aria-label={title}>
            <span className="fh-hub-folder grid flex-none [place-items:center] [width:38px] [height:38px] [border:1px_solid_var(--border)] [border-radius:10px] [background:var(--surface)]">
              <FolderIcon size={24} />
            </span>
            {titleNode}
            <p>{t("projects.freshIntro")}</p>
            {composer}
            {dataChips}
            <small>{t("projects.freshHint")}</small>
          </section>
        </div>
      ) : (
        <>
          <div className="fh-hub-scroll">
            <section className="fh-hub box-border w-full [max-width:1040px] [margin:0_auto] [padding:34px_18px_56px] [color:var(--fg)] [&_h1]:m-0 [&_h1]:[font-size:30px] [&_h1]:[letter-spacing:-0.03em] [&_.fh-hub-folder]:[border:0] [&_.fh-hub-folder]:[background:color-mix(in_srgb,var(--accent)_14%,transparent)] [&_.fh-hub-folder]:[color:var(--accent-text)]" aria-label={title}>
              <div className="fh-hub-header flex items-center [gap:12px] [margin-bottom:24px] [&_h1]:[flex:1] [&_h1]:min-w-0 [&_h1]:overflow-hidden [&_h1]:text-ellipsis [&_h1]:whitespace-nowrap">
                {backButton}
                <span className="fh-hub-folder grid flex-none [place-items:center] [width:38px] [height:38px] [border:1px_solid_var(--border)] [border-radius:10px] [background:var(--surface)]">
                  <FolderIcon size={20} />
                </span>
                <div className="fh-hub-header-title flex [flex:1] flex-col [gap:2px] min-w-0 [&&_h1]:[font-size:26px] [&_h1]:overflow-hidden [&_h1]:text-ellipsis [&_h1]:whitespace-nowrap [&_small]:[color:var(--muted)] [&_small]:[font-size:13px]">
                  {titleNode}
                  <small>
                    {t("projects.meta", {
                      chats: String(chats.length),
                      sources: String(sources.length),
                      outputs: String(projectOutputs.length + chatOutputs.length + otherOutputs.length),
                    })}
                  </small>
                </div>
                {editButtons}
              </div>
              {sources.length > 0 && dataChips}
        <div className="fh-hub-tabs flex [gap:4px] [margin-top:26px] [border-bottom:1px_solid_var(--border)] [&_button]:[height:auto] [&_button]:[padding:11px_17px] [&_button]:[border:0] [&&_button]:[border-bottom:2px_solid_transparent] [&_button]:[border-radius:0] [&_button]:[background:transparent] [&_button]:[color:var(--muted)] [&_button]:[font:inherit] [&_button]:cursor-pointer [&_button_span]:[margin-left:6px] [&_button_span]:[opacity:0.65] [&_button.active]:[color:var(--fg)] [&_button.active]:[font-weight:650] [&_button.active]:[border-bottom-color:var(--accent)]" role="tablist">
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
          <div className="fh-hub-list flex flex-col">
            {chats.map((chat) => (
              <button type="button" key={chat.sessionId} className="fh-hub-content-row w-full [height:auto] [border:0] [&&]:[border-bottom:1px_solid_var(--border)] [border-radius:0] [background:transparent] [color:inherit] [font:inherit] cursor-pointer [&:hover]:[background:var(--bg-hover)] flex items-center [gap:13px] [padding:15px_8px] text-left [&>span]:flex [&>span]:flex-col [&>span]:[gap:4px] [&>span]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_small]:[color:var(--muted)]" onClick={() => runtime.switchSession(chat.sessionId, project.projectId)}>
                <span>
                  <strong>{chat.title ?? t("historyChat.untitled", { id: chat.sessionId.slice(0, 8) })}</strong>
                  <small>{dateLabel(chat.updatedAt, t)}</small>
                </span>
              </button>
            ))}
            {chats.length === 0 && <div className="fh-hub-empty [padding:44px_12px] [color:var(--muted)] text-center">{t("projects.noChats")}</div>}
          </div>
        )}

        {tab === "sources" && (
          <div className="fh-hub-sources [padding-top:18px]">
            <button type="button" className="fh-hub-dropzone flex flex-col items-center [gap:7px] w-full [height:auto] [padding:35px_20px] [border:1px_dashed_var(--border)] [border-radius:18px] [background:transparent] [color:inherit] [font:inherit] cursor-pointer [&_span]:[color:var(--muted)] [&_span]:[font-size:13px]" onClick={() => inputRef.current?.click()} disabled={progress !== undefined}>
              <PaperclipIcon size={24} />
              <strong>{t("projects.dropTitle")}</strong>
              <span>{t("projects.dropHint")}</span>
              {progress !== undefined && (
                <span className="fh-hub-progress [width:min(360px,80%)] [height:5px] [margin-top:5px] overflow-hidden [border-radius:999px] [background:var(--border)] [&_i]:block [&_i]:h-full [&_i]:[background:var(--accent)]">
                  <i style={{ width: `${progress}%` }} />
                </span>
              )}
            </button>
            <div className="fh-hub-list flex flex-col">
              {sources.map((file) => {
                const dataset = DATASET_RE.test(file.path);
                const Icon = dataset ? FileSpreadsheetIcon : FileTextIcon;
                return (
                  <button type="button" key={file.path} className="fh-hub-content-row w-full [height:auto] [border:0] [&&]:[border-bottom:1px_solid_var(--border)] [border-radius:0] [background:transparent] [color:inherit] [font:inherit] cursor-pointer [&:hover]:[background:var(--bg-hover)] flex items-center [gap:13px] [padding:15px_8px] text-left [&>span]:flex [&>span]:flex-col [&>span]:[gap:4px] [&>span]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_small]:[color:var(--muted)]" onClick={() => void openFile(file.path)}>
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
              {sources.length === 0 && <div className="fh-hub-empty [padding:44px_12px] [color:var(--muted)] text-center">{t("projects.noSources")}</div>}
            </div>
          </div>
        )}

        {tab === "outputs" && (
          <div className="fh-hub-outputs grid [gap:28px] [padding-top:22px]">
            <section className="fh-hub-output-group overflow-hidden [border:1px_solid_var(--border)] [border-radius:18px]">
              <div className="fh-hub-output-heading flex items-start justify-between [gap:20px] [padding:18px_20px] [background:var(--surface)] [&_h2]:[margin:0_0_5px] [&_h2]:[font-size:16px] [&_p]:m-0 [&_p]:[color:var(--muted)] [&_p]:[font-size:13px] [&>span]:grid [&>span]:[place-items:center] [&>span]:[min-width:28px] [&>span]:[height:28px] [&>span]:[border-radius:999px] [&>span]:[background:var(--bg)] [&&>span]:[color:var(--muted)] [&&>span]:[font-size:12px]">
                <div>
                  <h2>{t("projects.outputsProject")}</h2>
                  <p>{t("projects.outputsProjectHint")}</p>
                </div>
                <span>{projectOutputs.length}</span>
              </div>
              {projectOutputs.map((file) => (
                <div className="fh-hub-output-row flex items-center [gap:12px] [padding-right:12px] [border-bottom:1px_solid_var(--border)] [&:last-child]:[border-bottom:0] [@media(max-width:720px)]:flex-col [@media(max-width:720px)]:items-stretch [@media(max-width:720px)]:[padding:0_10px_12px]" key={file.path}>
                  <button type="button" className="fh-hub-output-file [&>span]:flex [&>span]:flex-col [&>span]:[gap:4px] [&>span]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_small]:[color:var(--muted)] flex [flex:1] items-center [gap:13px] min-w-0 [height:auto] [padding:15px_8px] [border:0] [border-radius:0] [background:transparent] [color:inherit] [font:inherit] text-left cursor-pointer" onClick={() => void openFile(file.path)}>
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
              {projectOutputs.length === 0 && <div className="fh-hub-empty [padding:44px_12px] [color:var(--muted)] text-center">{t("projects.noOutputs")}</div>}
            </section>

            <section className="fh-hub-output-group overflow-hidden [border:1px_solid_var(--border)] [border-radius:18px]">
              <div className="fh-hub-output-heading flex items-start justify-between [gap:20px] [padding:18px_20px] [background:var(--surface)] [&_h2]:[margin:0_0_5px] [&_h2]:[font-size:16px] [&_p]:m-0 [&_p]:[color:var(--muted)] [&_p]:[font-size:13px] [&>span]:grid [&>span]:[place-items:center] [&>span]:[min-width:28px] [&>span]:[height:28px] [&>span]:[border-radius:999px] [&>span]:[background:var(--bg)] [&&>span]:[color:var(--muted)] [&&>span]:[font-size:12px]">
                <div>
                  <h2>{t("projects.outputsChats")}</h2>
                  <p>{t("projects.outputsChatsHint")}</p>
                </div>
                <span>{chatOutputs.length}</span>
              </div>
              {chatOutputs.map((output) => (
                <div className="fh-hub-output-row flex items-center [gap:12px] [padding-right:12px] [border-bottom:1px_solid_var(--border)] [&:last-child]:[border-bottom:0] [@media(max-width:720px)]:flex-col [@media(max-width:720px)]:items-stretch [@media(max-width:720px)]:[padding:0_10px_12px]" key={output.file.path}>
                  <button type="button" className="fh-hub-output-file [&>span]:flex [&>span]:flex-col [&>span]:[gap:4px] [&>span]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_small]:[color:var(--muted)] flex [flex:1] items-center [gap:13px] min-w-0 [height:auto] [padding:15px_8px] [border:0] [border-radius:0] [background:transparent] [color:inherit] [font:inherit] text-left cursor-pointer" onClick={() => void openFile(output.file.path)}>
                    <FileOutputIcon size={18} />
                    <span>
                      <strong>{output.path}</strong>
                      <small>
                        {chatTitle(output.sessionId)} · {formatSize(output.file.sizeBytes)}
                      </small>
                    </span>
                  </button>
                  <button type="button" className="fh-hub-promote inline-flex flex-none items-center [gap:6px] [height:auto] [min-height:34px] [padding:0_12px] [border:1px_solid_var(--border)] [border-radius:999px] [background:transparent] [color:inherit] [font:inherit] [&&]:font-semibold cursor-pointer [&:hover]:[background:var(--bg-hover)]" onClick={() => void promote(output.sessionId, output.path)}>
                    <ShareIcon size={15} />
                    {t("projects.promote")}
                  </button>
                </div>
              ))}
              {chatOutputs.length === 0 && <div className="fh-hub-empty [padding:44px_12px] [color:var(--muted)] text-center">{t("projects.noOutputs")}</div>}
            </section>

            {otherOutputs.length > 0 && (
              <section className="fh-hub-output-group overflow-hidden [border:1px_solid_var(--border)] [border-radius:18px]">
                <div className="fh-hub-output-heading flex items-start justify-between [gap:20px] [padding:18px_20px] [background:var(--surface)] [&_h2]:[margin:0_0_5px] [&_h2]:[font-size:16px] [&_p]:m-0 [&_p]:[color:var(--muted)] [&_p]:[font-size:13px] [&>span]:grid [&>span]:[place-items:center] [&>span]:[min-width:28px] [&>span]:[height:28px] [&>span]:[border-radius:999px] [&>span]:[background:var(--bg)] [&&>span]:[color:var(--muted)] [&&>span]:[font-size:12px]">
                  <div>
                    <h2>{t("projects.outputsOther")}</h2>
                    <p>{t("projects.outputsOtherHint")}</p>
                  </div>
                  <span>{otherOutputs.length}</span>
                </div>
                {otherOutputs.map((file) => (
                  <div className="fh-hub-output-row flex items-center [gap:12px] [padding-right:12px] [border-bottom:1px_solid_var(--border)] [&:last-child]:[border-bottom:0] [@media(max-width:720px)]:flex-col [@media(max-width:720px)]:items-stretch [@media(max-width:720px)]:[padding:0_10px_12px]" key={file.path}>
                    <button type="button" className="fh-hub-output-file [&>span]:flex [&>span]:flex-col [&>span]:[gap:4px] [&>span]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_small]:[color:var(--muted)] flex [flex:1] items-center [gap:13px] min-w-0 [height:auto] [padding:15px_8px] [border:0] [border-radius:0] [background:transparent] [color:inherit] [font:inherit] text-left cursor-pointer" onClick={() => void openFile(file.path)}>
                      <FileOutputIcon size={18} />
                      <span>
                        <strong>{file.path}</strong>
                        <small>{formatSize(file.sizeBytes)}</small>
                      </span>
                    </button>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
            </section>
          </div>
          <div className="fh-hub-dock flex-none [padding:10px_18px_16px] [&>*]:box-border [&>*]:w-full [&>*]:[max-width:920px] [&>*]:[margin:0_auto] [&>small]:block [&>small]:[margin-top:8px] [&&>small]:[color:var(--muted)] [&&>small]:[font-size:12px] [&>small]:text-center">
            {composer}
            <small>{t("projects.askHint")}</small>
          </div>
        </>
      )}
      {preview && (
        <div className="fh-workspace-preview fixed [inset:0] [z-index:50] flex flex-col items-center justify-center [gap:0.5em] [background:rgba(0,0,0,0.7)] [color:#fff] [cursor:zoom-out] [&_img]:[max-width:90vw] [&_img]:[max-height:80vh] [&_img]:[background:#fff] [&_img]:[border-radius:8px]" role="dialog" onClick={closePreview}>
          <img src={preview.url} alt={preview.path} />
          <span>{preview.path}</span>
        </div>
      )}
    </div>
  );
}

// Above a chat that belongs to a project: a way back to that project's page
// (project chats are listed there, not in the sidebar history). Also reports
// where the open chat lives, so App.tsx can keep its URL in the right area.
export function ProjectChatBar({
  onOpenProject,
  onChatPlace,
}: {
  onOpenProject: (projectId: string) => void;
  onChatPlace: (sessionId: string, flow: string, projectId: string | null) => void;
}) {
  const runtime = useRuntime();
  const [project, setProject] = useState<{ projectId: string; name: string } | null>(null);

  // The open chat's row in the shared chat list (src/queries.ts), reported once per chat.
  const sessions = useMySessions().data;
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    setProject(null);
    reportedRef.current = null;
    if (!runtime.sessionId) return;
    // A brand-new chat is listed only once its first message is in; refetch the list
    // when a live turn starts. onFrame replays past frames on subscribe — skip those.
    let live = false;
    const unsubscribe = runtime.onFrame((frame) => {
      if (live && reportedRef.current !== runtime.sessionId && frame.type === "event" && frame.event.type === "turn/start") {
        void queryClient.invalidateQueries({ queryKey: MY_SESSIONS_KEY });
      }
    });
    live = true;
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.sessionId]);
  useEffect(() => {
    if (!runtime.sessionId || reportedRef.current === runtime.sessionId) return;
    const row = sessions?.find((item) => item.sessionId === runtime.sessionId);
    if (!row) return;
    reportedRef.current = row.sessionId;
    onChatPlace(row.sessionId, row.flow, row.projectId);
    if (row.projectId && row.projectName) setProject({ projectId: row.projectId, name: row.projectName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, runtime.sessionId]);

  if (!project) return null;
  return (
    <div className="fh-chat-project-bar [&_button]:inline-flex [&_button]:items-center [&_button]:[gap:6px] [&_button]:[height:auto] [&&_button]:p-0 [&_button]:[border:0] [&_button]:[background:transparent] [&_button]:[color:var(--muted)] [&_button]:[font:inherit] [&&_button]:[font-size:12px] [&_button]:cursor-pointer [&_button:hover]:[color:var(--accent-text)] [&_svg]:[color:var(--accent)]">
      <button type="button" onClick={() => onOpenProject(project.projectId)}>
        <FolderIcon size={13} />
        {project.name}
      </button>
    </div>
  );
}
