// Chat attachments (docs/chat-attachments-plan.md): a file is uploaded to the chat's working directory as soon as
// it is picked, dropped or pasted; the message sent then ends with one marker line naming the files, which the
// model reads with its own tools and the chat turns back into file cards (also on reload — it is in the text).
// Modelled on examples/core's composer, with the names as JSON so a comma or a bracket in a name cannot break it.

import { useEffect, useRef, useState } from "react";

import type { Runtime } from "../../../runtime.ts";
import { MAX_UPLOAD_BYTES } from "./workspaceApi.ts";

export const MAX_ATTACHMENTS = 5;
const MARKER = "[Attached files in the working directory: ";
const MARKER_RE = /\n*\[Attached files in the working directory: (\[[^\n]*\])\]\s*$/;

/** The text sent for a message: what the user typed, then the marker line when files are attached. */
export function withAttachments(text: string, names: string[]): string {
  if (names.length === 0) return text;
  const marker = `${MARKER}${JSON.stringify(names)}]`;
  return text ? `${text}\n\n${marker}` : marker;
}

/** A sent message's text without the marker line, and the file names it named. */
export function splitAttachments(text: string): { text: string; names: string[] } {
  const match = MARKER_RE.exec(text);
  if (!match) return { text, names: [] };
  try {
    const names: unknown = JSON.parse(match[1]);
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) return { text, names: [] };
    return { text: text.slice(0, match.index).trimEnd(), names };
  } catch {
    return { text, names: [] };
  }
}

export const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

export interface PendingAttachment {
  id: string;
  file: File;
  status: "uploading" | "ready" | "error";
  progress: number;
  // the name the gateway saved it under (`a (2).csv` when `a.csv` was taken)
  savedName?: string;
  error?: "tooLarge" | "failed";
  previewUrl?: string;
}

/** `unique=1`: never replaces a file an earlier message may refer to (gateway saveUpload). */
function upload(
  runtime: Runtime,
  sessionId: string,
  file: File,
  onProgress: (fraction: number) => void,
  xhr: XMLHttpRequest,
): Promise<string> {
  return new Promise((resolve, reject) => {
    xhr.open("POST", runtime.apiUrl(`/sessions/${sessionId}/files?unique=1&name=${encodeURIComponent(file.name)}`));
    for (const [name, value] of Object.entries(runtime.authHeaders())) xhr.setRequestHeader(name, value);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`HTTP ${xhr.status}`));
      try {
        resolve((JSON.parse(xhr.responseText) as { path: string }).path);
      } catch {
        resolve(file.name);
      }
    };
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.onabort = () => reject(new Error("upload cancelled"));
    xhr.send(file);
  });
}

/** An uploaded attachment that will not be sent: it leaves the chat's files too. */
function discard(runtime: Runtime, sessionId: string, name: string): Promise<unknown> {
  const encoded = name.split("/").map(encodeURIComponent).join("/");
  return runtime.authedFetch(`/sessions/${sessionId}/files/${encoded}`, { method: "DELETE" }).catch(() => undefined);
}

/** The composer's pending attachments for the current chat; uploads start as files are added. */
export function useAttachments(runtime: Runtime, onUploaded: () => void) {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const sessionId = runtime.sessionId;
  // uploads in flight, so taking a card off cancels its upload
  const requests = useRef(new Map<string, XMLHttpRequest>());
  // cards taken off while their upload was finishing: the file that still landed is deleted
  const removed = useRef(new Set<string>());

  const patch = (id: string, change: Partial<PendingAttachment>) =>
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));

  function revoke(list: PendingAttachment[]): void {
    for (const item of list) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }

  // another chat: what was pending here was never sent — its uploads are cancelled and its files deleted
  useEffect(() => {
    return () => {
      if (sessionId) for (const item of itemsRef.current) drop(item, sessionId);
      setItems([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function drop(item: PendingAttachment, chat: string): void {
    revoke([item]);
    removed.current.add(item.id);
    requests.current.get(item.id)?.abort();
    if (item.status === "ready" && item.savedName) void discard(runtime, chat, item.savedName).then(onUploaded);
  }

  function start(item: PendingAttachment): void {
    if (!sessionId) return;
    const chat = sessionId;
    const xhr = new XMLHttpRequest();
    requests.current.set(item.id, xhr);
    upload(runtime, chat, item.file, (progress) => patch(item.id, { progress }), xhr)
      .then((savedName) => {
        if (removed.current.has(item.id)) return void discard(runtime, chat, savedName);
        patch(item.id, { status: "ready", progress: 1, savedName });
        onUploaded();
      })
      .catch(() => {
        if (!removed.current.has(item.id)) patch(item.id, { status: "error", error: "failed" });
      })
      .finally(() => requests.current.delete(item.id));
  }

  /** Adds files; returns how many were left out because of the per-message limit. */
  function add(files: Iterable<File>): number {
    const room = MAX_ATTACHMENTS - itemsRef.current.length;
    const list = [...files];
    const taken = list.slice(0, Math.max(room, 0)).map<PendingAttachment>((file) => ({
      id: crypto.randomUUID(),
      file,
      status: file.size > MAX_UPLOAD_BYTES ? "error" : "uploading",
      progress: 0,
      error: file.size > MAX_UPLOAD_BYTES ? "tooLarge" : undefined,
      previewUrl: IMAGE_RE.test(file.name) ? URL.createObjectURL(file) : undefined,
    }));
    setItems((current) => [...current, ...taken]);
    for (const item of taken) if (item.status === "uploading") start(item);
    return list.length - taken.length;
  }

  /** Takes a card off the message: its upload is cancelled, or the uploaded file deleted (it was never sent). */
  function remove(id: string): void {
    const item = itemsRef.current.find((i) => i.id === id);
    if (item && sessionId) drop(item, sessionId);
    setItems((list) => list.filter((i) => i.id !== id));
  }

  function retry(id: string): void {
    const item = itemsRef.current.find((i) => i.id === id);
    if (!item || item.error === "tooLarge") return;
    removed.current.delete(id);
    patch(id, { status: "uploading", progress: 0, error: undefined });
    start(item);
  }

  /** After sending: the names to put in the message, and the composer is cleared. */
  function take(): string[] {
    const names = itemsRef.current.filter((i) => i.status === "ready").map((i) => i.savedName ?? i.file.name);
    revoke(itemsRef.current);
    setItems([]);
    return names;
  }

  return {
    items,
    add,
    remove,
    retry,
    take,
    uploading: items.some((i) => i.status === "uploading"),
    ready: items.filter((i) => i.status === "ready").length,
  };
}
