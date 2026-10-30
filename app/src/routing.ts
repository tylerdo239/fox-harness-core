// The app's URLs and how they map to what is shown (split out of App.tsx, docs/ui-performance-plan.md §5).
// Plain functions over a pathname, so they are unit-tested (routing.test.ts) without a browser.

// Real `/chat/<id>` URL routing (2026-09-09), hidden until a session
// actually has content — mirrors the backend's own `sessions.first_message_at`
// rule (api/migrations/001_init.sql, services/gateway/src/db.ts) that
// already keeps an unchated session out of `GET /sessions/mine`: nothing
// session-specific shows anywhere (URL included) until a real message has
// been sent. Replaces the old `localStorage`-based `STORAGE_SESSION_ID` —
// the URL is strictly better for this exact piece of state (shareable,
// bookmarkable, and doesn't leak across tabs of the same origin the way
// `localStorage` does, a real latent bug the old approach had).
//
// Mirrors services/gateway/src/index.ts's own `SESSION_ID_RE` shape — not
// imported, services/*/app don't share runtime code (this repo's
// established boundary).
export const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The data-analysis area has its own URLs (2026-09-15) and its chats stay out
// of the general chat history:
//   /                          new general chat   /chat/<id>        general chat
//   /data                      project list       /data/<project>   project page
//   /data/<project>/chat/<id>  chat in a project  /data/chat/<id>   older data chat without a project
//   /data-studio               Data Studio home   /data-studio/chat/<id>  chat in Data Studio
//   /admin/usage               the admin usage dashboard (docs/admin-usage-dashboard-plan.md)
//   /my-skills                 the user's skills (SkillsPage.tsx); not /skills, the gateway's API route
export type Route =
  | { view: "adminUsage" }
  | { view: "skills" }
  | { view: "chat"; sessionId?: string }
  | { view: "hub"; projectId: string | null }
  | { view: "dataChat"; projectId: string | null; sessionId: string }
  | { view: "dataStudio"; sessionId?: string };

export function routeFromUrl(pathname: string = location.pathname): Route | undefined {
  const parts = pathname.split("/").filter(Boolean);
  const isId = (part: string | undefined) => part !== undefined && SESSION_ID_RE.test(part);
  if (parts.length === 0) return { view: "chat" };
  if (parts[0] === "chat" && parts.length === 2 && isId(parts[1])) return { view: "chat", sessionId: parts[1] };
  if (parts[0] === "admin" && parts[1] === "usage" && parts.length === 2) return { view: "adminUsage" };
  if (parts[0] === "my-skills" && parts.length === 1) return { view: "skills" };
  // docs/data-studio-agent-transfer-plan.md: Data Studio has its own URL space.
  if (parts[0] === "data-studio") {
    if (parts.length === 1) return { view: "dataStudio" };
    if (parts.length === 3 && parts[1] === "chat" && isId(parts[2])) return { view: "dataStudio", sessionId: parts[2] };
    return undefined;
  }
  if (parts[0] !== "data") return undefined;
  if (parts.length === 1) return { view: "hub", projectId: null };
  if (parts.length === 2 && isId(parts[1])) return { view: "hub", projectId: parts[1] };
  if (parts.length === 3 && parts[1] === "chat" && isId(parts[2])) return { view: "dataChat", projectId: null, sessionId: parts[2] };
  if (parts.length === 4 && isId(parts[1]) && parts[2] === "chat" && isId(parts[3])) {
    return { view: "dataChat", projectId: parts[1], sessionId: parts[3] };
  }
  return undefined;
}

export function sessionIdFromUrl(pathname: string = location.pathname): string | undefined {
  const route = routeFromUrl(pathname);
  return route && route.view !== "hub" && route.view !== "adminUsage" && route.view !== "skills" ? route.sessionId : undefined;
}

// Where a chat lives: the general chat area, the data area (in a project, or none), or Data Studio.
export type ChatPlace = { area: "chat" } | { area: "data"; projectId: string | null } | { area: "data-studio" };

export function chatPath(id: string, place: ChatPlace): string {
  if (place.area === "chat") return `/chat/${id}`;
  if (place.area === "data-studio") return `/data-studio/chat/${id}`;
  return place.projectId ? `/data/${place.projectId}/chat/${id}` : `/data/chat/${id}`;
}

export function hubPath(projectId: string | null): string {
  return projectId ? `/data/${projectId}` : "/data";
}

// True on any `/data-studio…` address (used for the initial Data Studio mode and for a fresh visit's flow).
export function isDataStudioUrl(pathname: string = location.pathname): boolean {
  return pathname === "/data-studio" || pathname.startsWith("/data-studio/");
}

// Shared by both the auto-reconnect-on-load effect and handleLogin — what to
// connect to given whatever's currently in the address bar. `flow` is only
// set for a brand-new `/data-studio` visit with no id yet (a normal `/chat/`
// or bare `/` visit gets `undefined`, same as before this flow existed).
export function initialSessionTarget(pathname: string = location.pathname): { path: string; flow?: string } {
  const sessionId = sessionIdFromUrl(pathname);
  if (sessionId) return { path: sessionId };
  return { path: "new", flow: isDataStudioUrl(pathname) ? "data-studio" : undefined };
}

// `replaceState` for transitions the app makes on the user's behalf (the
// auto-transition from `/` to `/chat/<id>` on a session's first message,
// or a stale-URL cleanup) — no new history entry, so Back skips past that
// state entirely. `pushState` for navigation the user actually clicked
// into (switching to a different chat, hitting "New chat") — Back/Forward
// should move between conversations someone deliberately opened. Matches
// how Back behaves on real chat platforms after sending a first message:
// it does NOT return to a blank compose screen.
export function replaceUrl(path: string): void {
  history.replaceState(null, "", path);
}
export function pushUrl(path: string): void {
  history.pushState(null, "", path);
}
