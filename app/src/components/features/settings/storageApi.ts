// docs/storage-quota-plan.md: what a user's files take against their quota (GET /storage), deleting them, and the
// admin's view of the bucket and the cleanup of unused files (/admin/storage). Mirrors services/gateway's
// runtime/storage.ts shapes — app doesn't import api/, same "mirrored, not imported" rule as wire.ts.

import { toast } from "sonner";

import type { TranslationKey } from "../../../i18n/translations.ts";
import type { Runtime } from "../../../runtime.ts";

export interface StorageFile {
  path: string;
  sizeBytes: number;
  modified: string;
}

/** The assistant's versions of one canvas (`canvas-<id>-vN`), docs/canvas-storage-plan.md. */
export interface StorageCanvas {
  id: string;
  versions: number;
  bytes: number;
  latest: string;
}

export interface StorageDir {
  kind: "chat" | "project";
  id: string;
  title: string | null;
  bytes: number;
  modified?: string;
  // visible files other than the canvas versions below
  files: StorageFile[];
  canvases: StorageCanvas[];
  // the canvas panel's own history (.canvas/): file snapshots and saved edits
  canvasHistory: { files: number; bytes: number };
}

export interface UserStorage {
  usedBytes: number;
  // 0 = no limit
  quotaBytes: number;
  warnPercent: number;
  bucketFull: boolean;
  dirs: StorageDir[];
}

export interface BucketStatus {
  capacityBytes: number;
  usedBytes?: number;
  objects?: number;
  scannedAt?: string;
  percent?: number;
  warnPercent: number;
  blockPercent: number;
}

export interface AdminStorage {
  bucket: BucketStatus;
  quotaBytes: number;
  fileRetentionDays: number;
  users: { userId: number; email: string; usedBytes: number }[];
}

export interface CleanupResult {
  olderThanDays: number;
  dryRun: boolean;
  dirs: number;
  files: number;
  bytes: number;
  skippedLive: number;
}

/** An upload the gateway refused for space: the user's quota (`storage_quota`) or the bucket (`storage_full`). */
export const STORAGE_CODES = ["storage_quota", "storage_full"] as const;
export type StorageCode = (typeof STORAGE_CODES)[number];

export function storageCodeOf(status: number, responseText: string): StorageCode | undefined {
  if (status !== 507) return undefined;
  try {
    const code = (JSON.parse(responseText) as { code?: string }).code;
    return STORAGE_CODES.find((c) => c === code);
  } catch {
    return undefined;
  }
}

/** Raised by an upload the gateway refused for space; the caller offers to open the storage settings. */
export class StorageFullError extends Error {
  code: StorageCode;
  constructor(code: StorageCode) {
    super(code);
    this.code = code;
  }
}

// App.tsx listens: opens Settings on the Storage tab (from an upload refused anywhere in the app).
export const OPEN_STORAGE_EVENT = "fh:open-storage";
export function openStorageSettings(): void {
  window.dispatchEvent(new Event(OPEN_STORAGE_EVENT));
}

/** The toast for an upload refused for space, with a button to the storage settings to delete old files. */
export function showNoSpace(error: StorageFullError, t: (key: TranslationKey) => string): void {
  toast.error(t(error.code === "storage_full" ? "storage.uploadBucketFull" : "storage.uploadQuota"), {
    duration: 10_000,
    action: { label: t("storage.manage"), onClick: openStorageSettings },
  });
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function getStorage(runtime: Runtime): Promise<UserStorage> {
  return json<UserStorage>(await runtime.authedFetch("/storage"));
}

const base = (dir: Pick<StorageDir, "kind" | "id">) => `/${dir.kind === "chat" ? "sessions" : "projects"}/${dir.id}`;

export async function deleteStorageFile(runtime: Runtime, dir: StorageDir, path: string): Promise<void> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await runtime.authedFetch(`${base(dir)}/files/${encoded}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
}

/** Every file of a chat or project; the chat itself stays. */
export async function clearStorageDir(runtime: Runtime, dir: StorageDir): Promise<{ files: number; bytes: number }> {
  return json(await runtime.authedFetch(`/storage${base(dir)}`, { method: "DELETE" }));
}

/** One canvas's versions: all of them (with its saved edits), or all but the newest. */
export async function deleteStorageCanvas(runtime: Runtime, dir: StorageDir, canvasId: string, keepLatest: boolean): Promise<{ files: number; bytes: number }> {
  const query = keepLatest ? "?keep=latest" : "";
  return json(await runtime.authedFetch(`/storage${base(dir)}/canvases/${encodeURIComponent(canvasId)}${query}`, { method: "DELETE" }));
}

/** The canvas history of a chat or project (.canvas/); the originals and the assistant's versions stay. */
export async function clearCanvasHistory(runtime: Runtime, dir: StorageDir): Promise<{ files: number; bytes: number }> {
  return json(await runtime.authedFetch(`/storage${base(dir)}/canvas-history`, { method: "DELETE" }));
}

export async function getAdminStorage(runtime: Runtime): Promise<AdminStorage> {
  return json<AdminStorage>(await runtime.authedFetch("/admin/storage"));
}

export async function runCleanup(runtime: Runtime, olderThanDays: number, dryRun: boolean): Promise<CleanupResult> {
  return json<CleanupResult>(
    await runtime.authedFetch("/admin/storage/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ olderThanDays, dryRun }),
    }),
  );
}
