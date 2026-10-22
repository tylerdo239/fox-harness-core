// GET /admin/usage/report and /admin/usage/users/:id (services/gateway/src/runtime/usage.ts) — the shapes mirror
// the gateway's UsageReport / userUsage. docs/admin-usage-dashboard-plan.md §5.
import type { Runtime } from "../../../runtime.ts";

export type Group = "day" | "week" | "month";

export interface Totals {
  activeUsers: number;
  chats: number;
  turns: number;
  completedTurns: number;
  cancelledTurns: number;
  failedTurns: number;
  blockedTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  toolCalls: number;
  toolErrors: number;
  attachments: number;
  avgTurnMs: number | null;
  medianTurnMs: number | null;
}

export interface UsageReport {
  range: { from: string; to: string; days: number; group: Group; utcOffsetMinutes: number; previousFrom: string; previousTo: string };
  totals: Totals;
  previous: Totals;
  series: (Totals & { key: string; from: string; to: string })[];
  hours: number[];
  weekdays: number[];
  outcomes: { completed: number; cancelled: number; failed: number; blocked: number; kinds: { kind: string; count: number }[] };
  users: (Totals & { id: number; email: string | null; role: string | null; lastActiveAt: string | null })[];
  models: { model: string; input: number; output: number; calls: number }[];
  flows: { flow: string; turns: number; inputTokens: number; outputTokens: number }[];
  tools: { tool: string; calls: number; errors: number }[];
  purposes: { purpose: string; calls: number; inputTokens: number; outputTokens: number }[];
  dataStudio: { turns: number; inputTokens: number; outputTokens: number; embeddingTokens: number; profileTokens: number };
  overhead: { compactionTokens: number; failedCalls: number; estimatedCalls: number; cacheShare: number | null };
  since: string | null;
}

export interface UserChat {
  sessionId: string;
  title: string | null;
  flow: string;
  projectId: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  lastActiveAt: string | null;
}

export interface UserUsage {
  user: { id: number; email: string | null; role: string | null };
  chats: UserChat[];
  next: number | null;
}

export interface Period {
  from: string;
  to: string;
  group: Group;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getUsageReport(runtime: Runtime, period: Period): Promise<UsageReport> {
  const query = new URLSearchParams({ from: period.from, to: period.to, group: period.group });
  return json<UsageReport>(await runtime.authedFetch(`/admin/usage/report?${query}`));
}

export async function getUserUsage(runtime: Runtime, userId: number, period: Period, offset = 0): Promise<UserUsage> {
  const query = new URLSearchParams({ from: period.from, to: period.to, offset: String(offset) });
  return json<UserUsage>(await runtime.authedFetch(`/admin/usage/users/${userId}?${query}`));
}
