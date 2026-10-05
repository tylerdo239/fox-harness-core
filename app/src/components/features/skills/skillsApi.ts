// Per-user skills (docs/skill-transfer-plan.md). Mirrors services/gateway's
// `GET /skills` + `/custom-skills` JSON shapes — apps/web doesn't import
// @fox-harness/contracts, same "mirrored, not imported" rule as wire.ts.

import type { Runtime } from "../../../runtime.ts";

export interface SkillMenuItem {
  name: string;
  description: string;
  source: "builtin" | "custom";
}

export interface CustomSkill {
  name: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillInput {
  name: string;
  description: string;
  content: string;
}

// Carries gateway's stable `code` so callers can translate it
// (`translateErrorCode`), same pattern as App.tsx's AuthError.
export class SkillApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function toError(res: Response): Promise<SkillApiError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  return new SkillApiError(body.error ?? `HTTP ${res.status}`, res.status, body.code);
}

export async function listCustomSkills(runtime: Runtime): Promise<CustomSkill[]> {
  const res = await runtime.authedFetch("/custom-skills");
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { skills: CustomSkill[] }).skills;
}

export async function createCustomSkill(runtime: Runtime, input: SkillInput): Promise<CustomSkill> {
  const res = await runtime.authedFetch("/custom-skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as CustomSkill;
}

// Renaming isn't supported — the name in the URL identifies the skill.
export async function updateCustomSkill(runtime: Runtime, input: SkillInput): Promise<CustomSkill> {
  const res = await runtime.authedFetch(`/custom-skills/${encodeURIComponent(input.name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: input.description, content: input.content }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as CustomSkill;
}

export async function deleteCustomSkill(runtime: Runtime, name: string): Promise<void> {
  const res = await runtime.authedFetch(`/custom-skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await toError(res);
}

// The "/" menu list, shared app-wide: whoever changes a skill (Skills dialog,
// a skill saved from chat) calls `refreshSkillMenu`, every subscriber updates.
let menuItems: SkillMenuItem[] = [];
const listeners = new Set<(items: SkillMenuItem[]) => void>();

export async function refreshSkillMenu(runtime: Runtime): Promise<void> {
  const res = await runtime.authedFetch("/skills");
  if (!res.ok) return;
  menuItems = ((await res.json()) as { skills: SkillMenuItem[] }).skills;
  for (const listener of listeners) listener(menuItems);
}

export function subscribeSkillMenu(listener: (items: SkillMenuItem[]) => void): () => void {
  listeners.add(listener);
  listener(menuItems);
  return () => listeners.delete(listener);
}
