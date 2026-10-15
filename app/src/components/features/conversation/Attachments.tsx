// The composer's pending attachments and a sent message's file cards (docs/chat-attachments-plan.md; attachments.ts
// has the upload and the marker line).

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { CloseIcon, FileTextIcon, RetryIcon } from "../../../icons.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
import { useRuntime } from "../../../runtime.ts";
import { IMAGE_RE, type PendingAttachment } from "./attachments.ts";
import { fetchWorkspaceFile, formatSize } from "./workspaceApi.ts";

type T = (key: TranslationKey, params?: Record<string, string>) => string;

export function PendingAttachments({
  items,
  onRemove,
  onRetry,
  t,
}: {
  items: PendingAttachment[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  t: T;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="fh-attach-chips">
      {items.map((item) => (
        <li key={item.id} className={`fh-attach-chip${item.status === "error" ? " fh-attach-chip-error" : ""}`}>
          {item.previewUrl ? (
            <img className="fh-attach-thumb" src={item.previewUrl} alt="" />
          ) : (
            <span className="fh-attach-icon">
              <FileTextIcon size={16} />
            </span>
          )}
          <span className="fh-attach-meta">
            <span className="fh-attach-name" title={item.file.name}>
              {item.file.name}
            </span>
            <span className="fh-attach-size">
              {item.status === "error"
                ? t(item.error === "tooLarge" ? "attach.tooLarge" : item.error === "noSpace" ? "attach.noSpace" : "attach.failed")
                : formatSize(item.file.size)}
            </span>
          </span>
          {item.status === "error" && item.error === "failed" && (
            <button type="button" className="fh-attach-action" title={t("attach.retry")} onClick={() => onRetry(item.id)}>
              <RetryIcon size={14} />
            </button>
          )}
          <button type="button" className="fh-attach-action" title={t("attach.remove")} onClick={() => onRemove(item.id)}>
            <CloseIcon size={14} />
          </button>
          {item.status === "uploading" && (
            <span className="fh-attach-progress" role="progressbar" aria-valuenow={Math.round(item.progress * 100)}>
              <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The files a sent message attached: images as thumbnails (click to view), other files to download. */
export function SentAttachments({ names, t }: { names: string[]; t: T }) {
  const runtime = useRuntime();
  const base = `/sessions/${runtime.sessionId}`;
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    for (const name of names.filter((n) => IMAGE_RE.test(n))) {
      fetchWorkspaceFile(runtime, base, name)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          urls.push(url);
          if (alive) setThumbs((current) => ({ ...current, [name]: url }));
        })
        .catch(() => {
          // the file is gone (deleted chat folder): the card stays, without a picture
        });
    }
    return () => {
      alive = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, names.join("\n")]);

  async function open(name: string): Promise<void> {
    if (thumbs[name]) return setPreview({ name, url: thumbs[name] });
    try {
      const url = URL.createObjectURL(await fetchWorkspaceFile(runtime, base, name));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast.error(t("workspace.openFailed", { name }));
    }
  }

  return (
    <>
      <ul className="fh-attach-sent">
        {names.map((name) => (
          <li key={name}>
            <button type="button" className="fh-attach-card" title={name} onClick={() => void open(name)}>
              {thumbs[name] ? (
                <img className="fh-attach-card-thumb" src={thumbs[name]} alt={name} />
              ) : (
                <>
                  <FileTextIcon size={16} />
                  <span className="fh-attach-name">{name}</span>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
      {preview && (
        <div className="fh-workspace-preview" role="dialog" onClick={() => setPreview(null)}>
          <img src={preview.url} alt={preview.name} />
          <span>{preview.name}</span>
        </div>
      )}
    </>
  );
}
