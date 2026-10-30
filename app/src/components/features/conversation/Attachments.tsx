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
    <ul className="fh-attach-chips [list-style:none] m-0 p-0 flex flex-wrap [gap:0.5em]">
      {items.map((item) => (
        <li key={item.id} className={`fh-attach-chip relative flex items-center [gap:0.5em] [width:13.5em] [padding:0.4em_0.4em_0.4em_0.45em] [border:1px_solid_var(--border)] [border-radius:var(--radius-md)] [background:var(--surface)] overflow-hidden${item.status === "error" ? " fh-attach-chip-error [&&]:[border-color:var(--error)] [&_.fh-attach-size]:[color:var(--error)]" : ""}`}>
          {item.previewUrl ? (
            <img className="fh-attach-thumb flex-none [width:2.25em] [height:2.25em] [border-radius:var(--radius-sm)] [object-fit:cover]" src={item.previewUrl} alt="" />
          ) : (
            <span className="fh-attach-icon flex-none [width:2.25em] [height:2.25em] [border-radius:var(--radius-sm)] [object-fit:cover] flex items-center justify-center [background:var(--bg-hover)] [color:var(--muted)]">
              <FileTextIcon size={16} />
            </span>
          )}
          <span className="fh-attach-meta flex flex-col min-w-0 [flex:1] [line-height:1.25]">
            <span className="fh-attach-name overflow-hidden text-ellipsis whitespace-nowrap [font-size:0.85em]" title={item.file.name}>
              {item.file.name}
            </span>
            <span className="fh-attach-size [font-size:0.75em] [color:var(--muted)]">
              {item.status === "error"
                ? t(item.error === "tooLarge" ? "attach.tooLarge" : item.error === "noSpace" ? "attach.noSpace" : "attach.failed")
                : formatSize(item.file.size)}
            </span>
          </span>
          {item.status === "error" && item.error === "failed" && (
            <button type="button" className="fh-attach-action [&_svg]:flex-none flex-none inline-flex [padding:0.2em] [border:none] [border-radius:var(--radius-sm)] [background:none] [color:var(--muted)] cursor-pointer [&:hover]:[background:var(--bg-hover)] [&:hover]:[color:var(--fg)]" title={t("attach.retry")} onClick={() => onRetry(item.id)}>
              <RetryIcon size={14} />
            </button>
          )}
          <button type="button" className="fh-attach-action [&_svg]:flex-none flex-none inline-flex [padding:0.2em] [border:none] [border-radius:var(--radius-sm)] [background:none] [color:var(--muted)] cursor-pointer [&:hover]:[background:var(--bg-hover)] [&:hover]:[color:var(--fg)]" title={t("attach.remove")} onClick={() => onRemove(item.id)}>
            <CloseIcon size={14} />
          </button>
          {item.status === "uploading" && (
            <span className="fh-attach-progress absolute [left:0] [right:0] [bottom:0] [height:3px] [background:var(--border-subtle)] [&>span]:block [&>span]:h-full [&>span]:[background:var(--accent)] [&>span]:[transition:width_var(--duration-fast)_var(--ease)]" role="progressbar" aria-valuenow={Math.round(item.progress * 100)}>
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
      <ul className="fh-attach-sent [list-style:none] m-0 p-0 flex flex-wrap justify-end [gap:0.4em]">
        {names.map((name) => (
          <li key={name}>
            <button type="button" className="fh-attach-card [&_svg]:flex-none flex items-center [gap:0.4em] [max-width:16em] [padding:0.45em_0.7em] [border:1px_solid_var(--border)] [border-radius:var(--radius-md)] [background:var(--surface)] [color:var(--fg)] cursor-pointer [&:hover]:[background:var(--bg-hover)] [&:has(.fh-attach-card-thumb)]:p-0 [&:has(.fh-attach-card-thumb)]:overflow-hidden" title={name} onClick={() => void open(name)}>
              {thumbs[name] ? (
                <img className="fh-attach-card-thumb block [max-width:14em] [max-height:10em] [object-fit:cover]" src={thumbs[name]} alt={name} />
              ) : (
                <>
                  <FileTextIcon size={16} />
                  <span className="fh-attach-name overflow-hidden text-ellipsis whitespace-nowrap [font-size:0.85em]">{name}</span>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
      {preview && (
        <div className="fh-workspace-preview fixed [inset:0] [z-index:50] flex flex-col items-center justify-center [gap:0.5em] [background:rgba(0,0,0,0.7)] [color:#fff] [cursor:zoom-out] [&_img]:[max-width:90vw] [&_img]:[max-height:80vh] [&_img]:[background:#fff] [&_img]:[border-radius:8px]" role="dialog" onClick={() => setPreview(null)}>
          <img src={preview.url} alt={preview.name} />
          <span>{preview.name}</span>
        </div>
      )}
    </>
  );
}
