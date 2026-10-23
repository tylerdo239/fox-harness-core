// The member's long-term memory (services/gateway/src/memory/, docs/memory-plugin-plan.md §4.2): shapes mirrored,
// not imported (same rule as storageApi.ts).
import type { Runtime } from "../../../runtime.ts";

export interface MemoryItem {
  id: string;
  /** "user": holds in every chat; "chat": one chat's */
  layer: "user" | "chat";
  sessionId?: string;
  chatTitle?: string | null;
  schema: string;
  text: string;
  updatedAt: string;
}

export interface MemoryState {
  configured: boolean;
  orgEnabled: boolean;
  enabled: boolean;
  memories: MemoryItem[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const getMemory = async (runtime: Runtime) => json<MemoryState>(await runtime.authedFetch("/memory"));
export const editMemory = async (runtime: Runtime, id: string, text: string) => json<{ ok: true }>(await runtime.authedFetch(`/memory/${id}`, send("PATCH", { text })));
export const deleteMemory = async (runtime: Runtime, id: string) => json<{ ok: true }>(await runtime.authedFetch(`/memory/${id}`, send("DELETE")));
export const clearMemory = async (runtime: Runtime, filter: { layer?: "user" | "chat"; sessionId?: string } = {}) =>
  json<{ removed: number }>(await runtime.authedFetch("/memory/clear", send("POST", filter)));
export const setMyMemory = async (runtime: Runtime, enabled: boolean) => json<{ enabled: boolean }>(await runtime.authedFetch("/memory/settings", send("PUT", { enabled })));
export const getChatMemory = async (runtime: Runtime, sessionId: string) =>
  json<{ enabled: boolean; available: boolean }>(await runtime.authedFetch(`/sessions/${sessionId}/memory`));
export const setChatMemory = async (runtime: Runtime, sessionId: string, enabled: boolean) =>
  json<{ enabled: boolean; available: boolean }>(await runtime.authedFetch(`/sessions/${sessionId}/memory`, send("PUT", { enabled })));
/** `locked`: the deployment sets it (MEMORY_ORG); the switch is read-only. */
export const getOrgMemory = async (runtime: Runtime) => json<{ enabled: boolean; configured: boolean; locked?: boolean }>(await runtime.authedFetch("/admin/memory"));
export const setOrgMemory = async (runtime: Runtime, enabled: boolean) =>
  json<{ enabled: boolean; configured: boolean }>(await runtime.authedFetch("/admin/memory", send("PUT", { enabled })));
