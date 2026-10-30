// Sign-in and where the gateway is: the stored token / email / role, login and logout requests (split out of
// App.tsx, docs/ui-performance-plan.md §5).

import type { UserRole } from "./runtime.ts";

export const STORAGE_TOKEN = "fox-harness/token";
export const STORAGE_GATEWAY = "fox-harness/gatewayUrl";
export const STORAGE_SIDEBAR_COLLAPSED = "fox-harness/sidebarCollapsed";
export const STORAGE_EMAIL = "fox-harness/email";
// The role `/auth/login` returned, stored next to the token (same lifetime). A stored token with no stored
// role (a login from before roles existed) reads as "user" — least privilege; the gateway is the real authority.
export const STORAGE_ROLE = "fox-harness/role";

export function storedRole(): UserRole {
  return localStorage.getItem(STORAGE_ROLE) === "admin" ? "admin" : "user";
}

export function defaultGatewayUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get("gateway");
  return (
    fromQuery ??
    localStorage.getItem(STORAGE_GATEWAY) ??
    // Always the page's own origin: nginx in the web container (app/Dockerfile) and the dev server
    // (Vite, app/vite.config.ts) both forward the API paths and the chat WebSocket to BACKEND_URL (app/.env).
    location.origin
  );
}

export function wsBaseFor(httpBase: string): string {
  return httpBase.replace(/^http/, "ws").replace(/\/$/, "");
}

// i18n (2026-09-10): services/gateway's `/auth/register`+`/auth/login` now
// also send a stable `code` alongside the existing `error` string
// (services/gateway/src/index.ts) — carrying both through lets the catch
// site translate by `code` (locale.tsx's `translateErrorCode`) while still
// falling back to the raw `error` message for anything the FE's
// translation table doesn't recognize (an older gateway with no `code` at
// all included, a code added to the backend before the FE dictionary
// catches up, ...). A plain `Error` can't carry the extra field.
export class AuthError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export async function login(
  httpBase: string,
  email: string,
  password: string,
): Promise<{ token: string; email: string; role: UserRole }> {
  const res = await fetch(`${httpBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new AuthError(
      body.error ?? `login failed: HTTP ${res.status}`,
      body.code,
    );
  }
  // Real gap fixed 2026-09-08: services/gateway's real response already
  // includes `email` (added same day) — the FE had never captured it, so
  // there was no way to show WHO is logged in anywhere in the UI.
  const body = (await res.json()) as { token: string; email: string; role?: string };
  return { token: body.token, email: body.email, role: body.role === "admin" ? "admin" : "user" };
}

export async function logoutRequest(httpBase: string, token: string): Promise<void> {
  await fetch(`${httpBase}/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch((error: unknown) => {
    console.error("fox-harness-web: logout request failed", error);
  });
}
