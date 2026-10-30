// Server data shared by several components, through TanStack Query (docs/ui-performance-plan.md §5): the chat list
// (`GET /sessions/mine`) and the projects (`GET /projects`). One request serves the sidebar history, the sidebar
// projects, the project hub and the project bar above a chat — they used to fetch it 3-4 times on every chat switch.
// A change (rename, delete, new project, a chat switch) calls `runtime.bumpSessionsVersion()`, which invalidates
// both; every mounted reader refetches once.
import { QueryClient, useQuery } from "@tanstack/react-query";

import { listProjects, type Project } from "./components/features/projects/projectsApi.ts";
import { useRuntime, type Runtime } from "./runtime.ts";

// Same timing as the hand-written fetches it replaces: no retry, no refetch on window focus; a component that
// mounts shows what is cached at once and refetches in the background.
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
});

export const MY_SESSIONS_KEY = ["sessions", "mine"] as const;
export const PROJECTS_KEY = ["projects"] as const;

// One row of `GET /sessions/mine` (services/gateway); only chats that have had a first message are listed.
export interface MySession {
  sessionId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  status: "running" | "hibernated" | "archived";
  flow: string;
  projectId: string | null;
  projectName: string | null;
}

export async function fetchMySessions(runtime: Runtime): Promise<MySession[]> {
  const res = await runtime.authedFetch("/sessions/mine");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MySession[];
}

export function useMySessions() {
  const runtime = useRuntime();
  return useQuery({ queryKey: MY_SESSIONS_KEY, queryFn: () => fetchMySessions(runtime) });
}

export function useProjects() {
  const runtime = useRuntime();
  return useQuery<Project[]>({ queryKey: PROJECTS_KEY, queryFn: () => listProjects(runtime) });
}

/**
 * Refetch the chat list and the projects (after a change, or a chat switch). `reuseInFlight`: a fetch already
 * running (the first load, right as the app connects) answers instead of being cancelled and sent again.
 */
export function invalidateSessions(reuseInFlight = false): Promise<void> {
  const options = { cancelRefetch: !reuseInFlight };
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: MY_SESSIONS_KEY }, options),
    queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }, options),
  ]).then(() => undefined);
}
