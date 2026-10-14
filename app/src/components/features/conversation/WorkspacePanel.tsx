// Files bar of a chat with a working directory (docs/rlm-transfer-plan.md giai đoạn 4): its files (uploads and the
// model's generated/ outputs), preview images, download the rest. Uploading is the composer's attach button
// (docs/chat-attachments-plan.md); `version` changes when one finished. Renders nothing for a chat without a
// working directory or with no file yet. In a project chat the directory is the project's shared folder (9.1).

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { FolderIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import {
  fetchWorkspaceFile,
  formatSize,
  listWorkspaceFiles,
  type WorkspaceFile,
} from "./workspaceApi.ts";

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

export function WorkspacePanel({ version = 0 }: { version?: number }) {
  const runtime = useRuntime();
  const { t } = useLocale();
  const base = runtime.sessionId ? `/sessions/${runtime.sessionId}` : "";
  const [files, setFiles] = useState<WorkspaceFile[] | undefined>();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);

  async function refresh(): Promise<void> {
    if (!base) return;
    try {
      // In a project chat: the sources, shared outputs, this chat's outputs and files of no known
      // chat — not other chats' output folders.
      setFiles(
        (await listWorkspaceFiles(runtime, base))?.filter(
          (file) => !file.sessionId || file.sessionId === runtime.sessionId,
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

  useEffect(() => {
    if (version > 0) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  if (files === undefined || files.length === 0) return null;

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
        <Button variant="link" className="fh-workspace-toggle" onClick={() => setOpen(!open)}>
          <FolderIcon size={14} />
          {t("workspace.files", { n: String(files.length) })}
        </Button>
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
