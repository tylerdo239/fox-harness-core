// Files bar for data-analysis chats (docs/rlm-transfer-plan.md giai đoạn 4):
// upload into the chat's working directory, list its files (including the
// model's generated/ outputs), preview images, download the rest. Renders
// nothing for a chat without a working directory. In a project chat the
// directory is the project's shared folder (docs/rlm-transfer-plan.md 9.1).

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { FolderIcon, PaperclipIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import {
  fetchWorkspaceFile,
  formatSize,
  listWorkspaceFiles,
  MAX_UPLOAD_BYTES,
  RULES_FILE,
  uploadWorkspaceFile,
  type WorkspaceFile,
} from "./workspaceApi.ts";

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

export function WorkspacePanel() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const base = runtime.sessionId ? `/sessions/${runtime.sessionId}` : "";
  const [files, setFiles] = useState<WorkspaceFile[] | undefined>();
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function refresh(): Promise<void> {
    if (!base) return;
    try {
      // In a project chat: the sources, shared outputs, this chat's outputs and files of no known
      // chat — not other chats' output folders.
      setFiles(
        (await listWorkspaceFiles(runtime, base))?.filter(
          (file) => file.path !== RULES_FILE && (!file.sessionId || file.sessionId === runtime.sessionId),
        ),
      );
    } catch {
      // keep the last list; the next turn/end refreshes again
    }
  }

  useEffect(() => {
    setFiles(undefined);
    setOpen(false);
    void refresh();
    // The model writes files during a turn: refresh when one ends. onFrame
    // replays past frames synchronously on subscribe — skip those.
    let live = false;
    const unsubscribe = runtime.onFrame((frame) => {
      if (live && frame.type === "event" && frame.event.type === "turn/end") void refresh();
    });
    live = true;
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  if (files === undefined) return null;

  async function upload(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return;
    setUploading(true);
    for (const file of Array.from(list)) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(t("workspace.tooLarge", { name: file.name }));
        continue;
      }
      try {
        await uploadWorkspaceFile(runtime, base, file);
        toast.success(t("workspace.uploaded", { name: file.name }));
      } catch {
        toast.error(t("workspace.uploadFailed", { name: file.name }));
      }
    }
    setUploading(false);
    setOpen(true);
    await refresh();
  }

  async function openFile(file: WorkspaceFile): Promise<void> {
    try {
      const url = URL.createObjectURL(await fetchWorkspaceFile(runtime, base, file.path));
      if (IMAGE_RE.test(file.path)) {
        setPreview({ path: file.path, url });
        return;
      }
      const link = document.createElement("a");
      link.href = url;
      link.download = file.path.split("/").pop() ?? file.path;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast.error(t("workspace.openFailed", { name: file.path }));
    }
  }

  function closePreview(): void {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  return (
    <div className="fh-workspace">
      <div className="fh-workspace-bar">
        <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading}>
          <PaperclipIcon size={14} />
          {uploading ? t("workspace.uploading") : t("workspace.upload")}
        </Button>
        <Button variant="link" className="fh-workspace-toggle" onClick={() => setOpen(!open)}>
          <FolderIcon size={14} />
          {t("workspace.files", { n: String(files.length) })}
        </Button>
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
      </div>
      {open && (
        <ul className="fh-workspace-list">
          {files.length === 0 ? (
            <li className="fh-workspace-empty">{t("workspace.empty")}</li>
          ) : (
            files.map((file) => (
              <li key={file.path}>
                <button type="button" className="fh-workspace-file" onClick={() => void openFile(file)}>
                  <span className="fh-workspace-file-path">
                    {file.sessionId ? file.path.slice(`generated/${file.sessionId}/`.length) : file.path}
                  </span>
                  <span className="fh-workspace-file-size">{formatSize(file.sizeBytes)}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      {preview && (
        <div className="fh-workspace-preview" role="dialog" onClick={closePreview}>
          <img src={preview.url} alt={preview.path} />
          <span>{preview.path}</span>
        </div>
      )}
    </div>
  );
}
