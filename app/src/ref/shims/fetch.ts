// Ours (not from the reference): the reference's lib/api.ts talks to its own FastAPI with a cookie; here every
// call goes to services/gateway with the app's bearer token (runtime.authedFetch, set by DataStudioProfile).
// /data-profile/* is forwarded as-is to the reference routes in the Python admin worker
// (gateway /data-studio/profile/* -> bridge/admin_runner.py `data_profile` -> src/apis/routes/*).
import type { Entity, EntityUpdateInput } from "@/lib/types";

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher | null = null;

export function setRefFetcher(next: Fetcher): void {
  fetcher = next;
}

function gatewayPath(path: string): string {
  if (path.startsWith("/data-profile/")) return `/data-studio/profile/${path.slice("/data-profile/".length)}`;
  throw new Error(`no gateway route for ${path}`);
}

export function refFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!fetcher) throw new Error("not signed in");
  // the reference sends cookies; the gateway wants the bearer token authedFetch adds
  const { credentials: _credentials, ...rest } = init ?? {};
  return fetcher(gatewayPath(path), rest);
}

// The reference reads tables from its /data-sources routes; ours are the gateway's (0/1 flags, synonyms as a
// JSON string, deprecated tables included).
interface GatewayEntity {
  id: string;
  physical_name: string;
  display_name: string;
  entity_type: Entity["entity_type"];
  description: string | null;
  synonyms: string;
  grain_description: string | null;
  row_count_est: number | null;
  is_exposed: 0 | 1;
  is_pii: 0 | 1;
  is_deprecated: 0 | 1;
}

function toEntity(e: GatewayEntity, columnCount = 0): Entity {
  let synonyms: string[] = [];
  try {
    synonyms = JSON.parse(e.synonyms || "[]");
  } catch {
    // keep []
  }
  return {
    id: e.id,
    physical_name: e.physical_name,
    display_name: e.display_name,
    entity_type: e.entity_type,
    description: e.description,
    synonyms,
    grain_description: e.grain_description,
    row_count_est: e.row_count_est,
    last_profiled_at: null,
    is_exposed: !!e.is_exposed,
    is_pii: !!e.is_pii,
    column_count: columnCount,
  };
}

async function gatewayJson<T>(path: string, init?: RequestInit): Promise<T> {
  if (!fetcher) throw new Error("not signed in");
  const res = await fetcher(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body as T;
}

export async function oursGetEntities(dataSourceId: string): Promise<Entity[]> {
  const id = encodeURIComponent(dataSourceId);
  // column counts: the gateway's entity rows have none, the profile summaries do
  const [rows, summaries] = await Promise.all([
    gatewayJson<GatewayEntity[]>(`/data-studio/sources/${id}/entities`),
    gatewayJson<{ entity_id: string; column_count: number }[]>(`/data-studio/profile/data-sources/${id}/entities`).catch(() => []),
  ]);
  const counts = new Map(summaries.map((s) => [s.entity_id, s.column_count]));
  return rows.filter((e) => !e.is_deprecated).map((e) => toEntity(e, counts.get(e.id)));
}

export async function oursUpdateEntity(entityId: string, input: EntityUpdateInput): Promise<Entity> {
  const row = await gatewayJson<GatewayEntity>(`/data-studio/entities/${encodeURIComponent(entityId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  // the source page replaces its card with this, so it needs the column count too
  const detail = await gatewayJson<{ columns: unknown[] }>(`/data-studio/profile/entities/${encodeURIComponent(entityId)}`)
    .catch(() => ({ columns: [] }));
  return toEntity(row, detail.columns.length);
}
