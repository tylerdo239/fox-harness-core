// Files in a working directory (docs/rlm-transfer-plan.md giai đoạn 4, 9.1):
// a data-analysis chat's (`base` = `/sessions/<id>`) or a project's
// (`/projects/<id>`). Mirrors services/gateway's …/files shapes — apps/web
// doesn't import @fox-harness/contracts, same "mirrored, not imported" rule as wire.ts.

import type { Runtime } from "../../../runtime.ts";

export interface WorkspaceFile {
  path: string;
  sizeBytes: number;
  modified: string;
  // `source` a user upload, `shared` a promoted output (outputs/), `chat` anything a chat wrote.
  origin: "source" | "shared" | "chat";
  // The chat whose output folder (generated/<sessionId>/) holds the file, when known.
  sessionId?: string;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Same cap as services/orchestrator's config.maxUploadBytes.
export const MAX_UPLOAD_BYTES = 70 * 1024 * 1024;

// Project rules: AGENTS.md in the project folder, which every chat of the project loads through
// dsh-agent-instructions (an edit reaches open chats at their next question). Edited in the
// project's Rules tab, not listed as a file.
export const RULES_FILE = "AGENTS.md";

// `undefined` when there is no working directory (not a data-analysis chat).
export async function listWorkspaceFiles(
  runtime: Runtime,
  base: string,
): Promise<WorkspaceFile[] | undefined> {
  const res = await runtime.authedFetch(`${base}/files`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { files: WorkspaceFile[] }).files;
}

export async function uploadWorkspaceFile(
  runtime: Runtime,
  base: string,
  file: File,
): Promise<void> {
  const res = await runtime.authedFetch(
    `${base}/files?name=${encodeURIComponent(file.name)}`,
    { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function fetchWorkspaceFile(
  runtime: Runtime,
  base: string,
  path: string,
): Promise<Blob> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await runtime.authedFetch(`${base}/files/${encoded}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}
