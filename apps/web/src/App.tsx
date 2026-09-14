/**
 * Top-level app (2026-09-08 follow-up — replaces apps/web/src/main.ts's
 * imperative shell). One single React app shared by every user, no more
 * per-session dynamically-composed UI plugins: the user decided the whole
 * manifest/module-loader/slots delivery mechanism (Phase 4-12) wasn't worth
 * the loading/caching bugs it kept causing without a real browser tool to
 * debug them with. Every former "UI plugin" (theme, conversation, session
 * list, settings, plugin inventory) is now just a component here.
 *
 * Talks directly to services/gateway's real wire protocol: `POST
 * /auth/{register,login,logout}` for accounts, then `/sessions/new` or
 * `/sessions/<id>` over WebSocket for `{session|snapshot|event|error}`
 * frames and `{followup|steer}` commands. See services/gateway/README.md
 * and packages/transport/README.md for the authoritative protocol docs.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";

import { ConnectForm } from "./components/features/auth/ConnectForm.tsx";
import { ThemeToggle } from "./components/features/auth/ThemeToggle.tsx";
import { Conversation } from "./components/features/conversation/Conversation.tsx";
import { LanguageSelect } from "./components/features/LanguageSelect.tsx";
import { SettingsDialog } from "./components/features/settings/SettingsDialog.tsx";
import { SkillsDialog } from "./components/features/skills/SkillsDialog.tsx";
import { Sidebar } from "./components/features/sidebar/Sidebar.tsx";
import {
  LocaleProvider,
  translateErrorCode,
  useLocale,
} from "./i18n/locale.tsx";
import { RuntimeContext, type Runtime } from "./runtime.ts";
import type { ServerToClient } from "./wire.ts";

const STORAGE_TOKEN = "fox-harness/token";
const STORAGE_GATEWAY = "fox-harness/gatewayUrl";
const STORAGE_SIDEBAR_COLLAPSED = "fox-harness/sidebarCollapsed";
const STORAGE_EMAIL = "fox-harness/email";

// Real 2-column frame (sidebar | center), reimplementing dsh's real
// `dsh-client-ui-layout`'s AppFrame algorithm — read directly from its
// actual installed (unminified) compiled output, not guessed
// (docs/code-rules.md's Phase 10 entry has the real research). Same
// breakpoint (1024px) and rail width (56px) as the real one; deliberately
// smaller — no drag-to-resize.
const SIDEBAR_AUTO_COLLAPSE = 1024;
const SIDEBAR_RAIL_WIDTH = 56;
const SIDEBAR_EXPANDED_WIDTH = 280;

function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)));
}

// Same 3-way concession algorithm as dsh's real `computeColumns` — sidebar
// first, then let center shrink, then (if still too tight) close details
// entirely. `details` is always 0 here (nothing occupies it), so this
// project only ever exercises the first two branches in practice.
function computeColumns(
  viewport: number,
  sidebar: number,
  details: number,
): { sidebar: number; center: number; details: number } {
  const s = sidebar === 0 ? SIDEBAR_RAIL_WIDTH : clampWidth(sidebar, 264, 420);
  const d0 = details === 0 ? 0 : clampWidth(details, 300, 520);
  if (s + d0 + 640 <= viewport)
    return { sidebar: s, center: viewport - s - d0, details: d0 };
  const d1 = d0 === 0 ? 0 : Math.max(300, viewport - s - 640);
  if (s + d1 + 640 <= viewport) return { sidebar: s, center: 640, details: d1 };
  return { sidebar: s, center: Math.max(0, viewport - s), details: 0 };
}

function defaultGatewayUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get("gateway");
  return (
    fromQuery ??
    localStorage.getItem(STORAGE_GATEWAY) ??
    "http://localhost:4000"
  );
}

function wsBaseFor(httpBase: string): string {
  return httpBase.replace(/^http/, "ws").replace(/\/$/, "");
}

// Real `/chat/<id>` URL routing (2026-09-09), hidden until a session
// actually has content — mirrors the backend's own `sessions.first_message_at`
// rule (infra/migrations/001_init.sql, services/gateway/src/db.ts) that
// already keeps an unchated session out of `GET /sessions/mine`: nothing
// session-specific shows anywhere (URL included) until a real message has
// been sent. Replaces the old `localStorage`-based `STORAGE_SESSION_ID` —
// the URL is strictly better for this exact piece of state (shareable,
// bookmarkable, and doesn't leak across tabs of the same origin the way
// `localStorage` does, a real latent bug the old approach had).
//
// Mirrors services/gateway/src/index.ts's own `SESSION_ID_RE` shape — not
// imported, services/*/apps/web don't share runtime code (this repo's
// established boundary).
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionIdFromUrl(): string | undefined {
  const match = /^\/chat\/([^/]+)$/.exec(location.pathname);
  return match && SESSION_ID_RE.test(match[1]) ? match[1] : undefined;
}

// `replaceState` for transitions the app makes on the user's behalf (the
// auto-transition from `/` to `/chat/<id>` on a session's first message,
// or a stale-URL cleanup) — no new history entry, so Back skips past that
// state entirely. `pushState` for navigation the user actually clicked
// into (switching to a different chat, hitting "New chat") — Back/Forward
// should move between conversations someone deliberately opened. Matches
// how Back behaves on real chat platforms after sending a first message:
// it does NOT return to a blank compose screen.
function replaceChatUrl(id: string): void {
  history.replaceState(null, "", `/chat/${id}`);
}
function pushChatUrl(id: string): void {
  history.pushState(null, "", `/chat/${id}`);
}
function pushHomeUrl(): void {
  history.pushState(null, "", "/");
}
function replaceHomeUrl(): void {
  history.replaceState(null, "", "/");
}

// i18n (2026-09-10): services/gateway's `/auth/register`+`/auth/login` now
// also send a stable `code` alongside the existing `error` string
// (services/gateway/src/index.ts) — carrying both through lets the catch
// site translate by `code` (locale.tsx's `translateErrorCode`) while still
// falling back to the raw `error` message for anything the FE's
// translation table doesn't recognize (an older gateway with no `code` at
// all included, a code added to the backend before the FE dictionary
// catches up, ...). A plain `Error` can't carry the extra field.
class AuthError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function login(
  httpBase: string,
  email: string,
  password: string,
): Promise<{ token: string; email: string }> {
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
  const body = (await res.json()) as { token: string; email: string };
  return body;
}

async function register(
  httpBase: string,
  email: string,
  password: string,
): Promise<void> {
  const res = await fetch(`${httpBase}/auth/register`, {
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
      body.error ?? `register failed: HTTP ${res.status}`,
      body.code,
    );
  }
}

async function logoutRequest(httpBase: string, token: string): Promise<void> {
  await fetch(`${httpBase}/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch((error: unknown) => {
    console.error("fox-harness-web: logout request failed", error);
  });
}

// i18n (2026-09-10): thin wrapper so `<LocaleProvider>` sits OUTSIDE both
// of AppInner's returns (the `!authenticated` early-return auth screen and
// the main app-frame return) — the login screen has to be translatable
// BEFORE the user ever logs in, so the provider can't just wrap the
// app-frame branch the way `RuntimeContext.Provider` below does.
export function App() {
  return (
    <LocaleProvider>
      <AppInner />
      {/* Real crash fixed 2026-09-10 (found while jsdom-testing the
          HistoryChat rename flow, not reported directly — user said
          "chưa đổi được tên", and this was the actual root cause): used to
          be 2 separate `<Toaster>` elements, one inside AppInner's
          `!authenticated` early return, one inside its main app-frame
          return — mutually exclusive branches at the SAME tree position.
          The instant `authenticated` flips true (right after login/
          auto-reconnect), React unmounts the WHOLE auth-screen subtree
          (including its Toaster) and mounts the WHOLE app-frame subtree
          (including a SECOND, brand-new Toaster) in the same commit.
          sonner's Toaster manages its own portaled DOM node internally —
          2 instances mounting/unmounting into that same portal target in
          one commit raced, throwing a real, uncaught
          "The node to be removed is not a child of this node"
          DOMException that crashed the whole app (caught by
          ErrorBoundary.tsx, which then rebuilds the entire tree from
          scratch — confirmed via a real jsdom+React run of the actual
          built `main.js`, not just static reading). One `<Toaster>` here
          instead, outside AppInner entirely, mounted exactly once for the
          whole tab's lifetime regardless of `authenticated` — it already
          needs to work on BOTH screens anyway (e.g. `app.sessionExpired`
          fires FROM the app frame but is only ever SEEN once the screen
          has already dropped back to the auth screen). `theme="light"` is
          arbitrary and doesn't actually matter (style.css overrides
          sonner's own `--normal-bg`/`--success-*`/`--error-*` variables to
          point at this app's own tokens regardless of which theme value
          sonner thinks it's in). `richColors` is required for sonner to
          actually use those variables at all (confirmed in its real
          compiled CSS: gated behind `[data-rich-colors=true]`). */}
      <Toaster theme="light" position="top-right" closeButton richColors />
    </LocaleProvider>
  );
}

function AppInner() {
  const { t } = useLocale();
  const [status, setStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  // Real bug fixed 2026-09-09 ("lúc move giữa 2 route có reload giật"): this
  // used to be derived straight from `status` (`connected = status ===
  // 'connected'`), and the app frame only rendered `if (connected)` — so
  // EVERY switchSession()/startNewSession()/popstate reconnect, which closes
  // the old socket and briefly passes through 'connecting' (and sometimes a
  // transient 'disconnected' mid self-heal-retry) before the new one opens,
  // unmounted the whole app (sidebar/header/conversation) back to the
  // full-screen <ConnectForm> and remounted it a moment later. Pure React
  // state, not a real browser navigation, but visually identical to a page
  // reload — exactly the "giật" the user reported, and exactly what
  // deepseek/claude don't do when you switch chats. `authenticated` is the
  // real gate for the full-screen auth swap now: true once this tab has
  // ever had a socket actually open, false only on a genuine logout/auth
  // expiry. Transient WS reconnects in between just move `status`, which
  // the header's existing status pill already reflects — no full unmount.
  const [authenticated, setAuthenticated] = useState(false);
  // Real gap fixed 2026-09-10 ("lúc quay lại web khi đang check token nên
  // có màn loading để tránh hiện form login") — a reload (or a brand-new
  // tab, since the token lives in localStorage now) with a stored token
  // used to flash the full login form for the brief window between mount
  // and the silent auto-reconnect effect's WS actually opening, even
  // though the reconnect succeeds almost every time. Starts `true` ONLY
  // when a token is actually stored (nothing to silently check otherwise
  // — a genuinely logged-out visitor sees the login form immediately, no
  // artificial delay). Flipped back to `false` in exactly the 3 places
  // that reach a DEFINITIVE answer for that first reconnect attempt: the
  // WS actually opening (success), `handleAuthExpired()` (token was
  // dead), and the terminal `setStatus('disconnected')` inside
  // `connect()`'s own close handler (gateway unreachable/network down) —
  // never flipped back to `true` afterward, so it only ever gates this
  // one initial-load window, not later logins/switches.
  const [authCheckPending, setAuthCheckPending] = useState(
    () => !!localStorage.getItem(STORAGE_TOKEN),
  );
  const [sessionId, setSessionId] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  // No UI ever changes these now (2026-09-08, docs/code-rules.md §36) —
  // `gatewayUrl` is still overridable via `?gateway=` in the page URL
  // (`defaultGatewayUrl()`), `selectedModel` auto-populates from the first
  // entry `GET /models` returns (`pickDefaultModel()` below).
  const [gatewayUrl] = useState(defaultGatewayUrl());
  const [selectedModel, setSelectedModel] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  // `sidebarManuallyExpanded`: a NARROW-viewport temporary reveal (the
  // header hamburger) — never persisted, since it's inherently a
  // space-constrained fallback, not a real preference. `sidebarPinnedCollapsed`:
  // a real user preference on WIDE viewports (Phase 15, 2026-09-08 — real
  // dsh has a persistent collapse-to-rail toggle IN the sidebar itself,
  // this app previously had no way to collapse the sidebar at all on a
  // wide screen), persisted the same way `useTheme.ts` persists its choice.
  const [sidebarManuallyExpanded, setSidebarManuallyExpanded] = useState(false);
  const [sidebarPinnedCollapsed, setSidebarPinnedCollapsed] = useState(
    () => localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED) === "1",
  );
  // Real gap fixed 2026-09-10 ("khi mở tab mới app bắt login lại"): this
  // was sessionStorage until now — deliberately, at the time (2026-09-08),
  // to keep "who this tab is logged in as" from being a durable
  // cross-session preference. That reasoning turned out wrong for a TOKEN
  // specifically: sessionStorage is scoped per TAB, not just per browser
  // session, so a brand-new tab (even signed in on the same browser one
  // tab over) had no token at all and got bounced to the login screen —
  // real chat platforms don't do this, being logged in on one tab means
  // being logged in on every tab of that browser. localStorage fixes that
  // (shared across tabs of the same origin); logging out already revokes
  // the token server-side too (`handleLogout`'s `logoutRequest`), so a
  // stale copy in another tab self-heals on its next request/reconnect
  // via the existing 401/handshake-rejection handling, not a new
  // mechanism. Read back on mount so a plain reload (which reconnects via
  // the stored token, not a fresh login() call) still knows who's logged in.
  const [userEmail, setUserEmail] = useState(
    () => localStorage.getItem(STORAGE_EMAIL) ?? "",
  );
  // Drives both the URL-update trigger and the visible session-id (session-bar
  // below) — lazy-initialized from whatever the URL already says on first
  // paint, so a direct `/chat/<id>` visit doesn't flash "no session" first.
  const [hasChatted, setHasChatted] = useState(() => !!sessionIdFromUrl());

  const frameRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const gatewayHttpBaseRef = useRef("");
  const frameHistoryRef = useRef<ServerToClient[]>([]);
  const frameListenersRef = useRef(new Set<(frame: ServerToClient) => void>());

  function publishFrame(frame: ServerToClient): void {
    if (frame.type === "snapshot") frameHistoryRef.current = [frame];
    else frameHistoryRef.current.push(frame);
    for (const listener of frameListenersRef.current) listener(frame);
  }

  // Real gap fixed 2026-09-09: the one place that actually knows "the
  // token is dead" reacts by clearing it and sending the user back to
  // <ConnectForm> (rendered whenever `!authenticated`) — factored
  // out so `connect()`'s handshake-rejection probe below and
  // `runtime.authedFetch`'s 401 handling both go through the exact same
  // behavior/copy instead of duplicating it. Deliberately does NOT touch
  // the URL — `handleLogin()` already resumes whatever `/chat/<id>` is
  // currently showing, so logging back in picks up exactly where the user
  // left off instead of losing the session over what was only ever a token
  // problem.
  function handleAuthExpired(): void {
    localStorage.removeItem(STORAGE_TOKEN);
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("disconnected");
    setAuthenticated(false);
    setAuthCheckPending(false);
    toast.info(t("app.sessionExpired"));
  }

  function connect(
    httpBase: string,
    token: string,
    sessionPath: string,
    flow?: string,
  ): void {
    gatewayHttpBaseRef.current = httpBase;
    localStorage.setItem(STORAGE_TOKEN, token);
    localStorage.setItem(STORAGE_GATEWAY, httpBase);

    setStatus("connecting");
    // Only meaningful for a brand-new session — services/orchestrator's
    // ensure.ts ignores it for a reconnect/rehydrate, which reuses whatever
    // model that session was actually created with.
    const modelParam =
      sessionPath === "new" && selectedModel
        ? `&model=${encodeURIComponent(selectedModel)}`
        : "";
    // docs/data-analysis-flow-plan.md: same rule as `modelParam` above, for
    // which agent loop/profile a brand-new session spawns with. Undefined
    // means the default flow — omitted entirely, not sent as an empty param.
    const flowParam =
      sessionPath === "new" && flow ? `&flow=${encodeURIComponent(flow)}` : "";
    const socket = new WebSocket(
      `${wsBaseFor(httpBase)}/sessions/${sessionPath}?token=${encodeURIComponent(token)}${modelParam}${flowParam}`,
    );
    wsRef.current = socket;
    // Set by the 'open' handler below — read by 'close'/the 'error' grace
    // timer to tell "handshake was flat-out rejected" apart from
    // "connected fine, then disconnected later" (real gap fixed 2026-09-09).
    let didOpen = false;
    // Guards `handleHandshakeFailure` against running twice — it's now
    // reachable from 2 different event paths (see the 'error' listener's
    // own comment for why).
    let handshakeSettled = false;

    if (sessionPath !== "new") setSessionId(sessionPath);

    socket.addEventListener("open", () => {
      didOpen = true;
      handshakeSettled = true;
      setStatus("connected");
      setAuthenticated(true);
      setAuthCheckPending(false);
    });

    // Real gap fixed 2026-09-10 (found while testing the new "checking
    // token" loading screen with a deliberately-invalid stored token,
    // confirmed directly against the real running gateway, not guessed):
    // this app's own WS-rejection response
    // (`server.on('upgrade', ...)`'s `socket.write('HTTP/1.1 401...');
    // socket.destroy()`, services/gateway/src/index.ts) is a raw, abrupt
    // socket teardown, not a real WebSocket close handshake — Node's own
    // `WebSocket` client fires 'error' for it almost instantly but then
    // NEVER fires 'close' at all (confirmed: none within 10 real seconds
    // against the real gateway). This function used to assume "'close'
    // fires immediately after 'error'" and did ALL of its handling there
    // — for this exact rejection shape it simply never fires, leaving
    // `status` stuck on 'connecting' (and, worse, the loading screen
    // above stuck spinning) forever for anyone with a stale/invalid
    // stored token. WS `error` events still carry no diagnostic info by
    // spec (opaque for security) — this doesn't try to read anything
    // from it, just uses it to start a short grace timer: if 'close'
    // hasn't ALSO fired by then, handle the failure directly instead of
    // waiting on an event that may never come.
    socket.addEventListener("error", () => {
      setTimeout(() => {
        if (wsRef.current !== socket || handshakeSettled) return;
        handshakeSettled = true;
        wsRef.current = null;
        void handleHandshakeFailure();
      }, 300);
    });

    // Real gap fixed 2026-09-09: a rejected handshake (never `open()`ed)
    // looks IDENTICAL to browser JS whether the gateway 401'd (token
    // dead — e.g. sliding expiration finally caught up) or 403'd (token
    // fine, but this SESSION isn't reachable/owned) — WS `close`/`error`
    // carry no status code by spec. Getting this wrong matters: treating
    // an expired token as "session gone" would needlessly wipe a
    // perfectly good `/chat/<id>` URL and burn the retry-as-new attempt
    // below on a request that's going to 401 again anyway (same dead
    // token). One lightweight authenticated REST call — which DOES
    // expose a real status code, unlike the WS handshake — disambiguates
    // before deciding anything destructive. Factored into its own named
    // function 2026-09-10 so both the 'close' handler below AND the
    // 'error' grace timer above can reach it.
    async function handleHandshakeFailure(): Promise<void> {
      const probe = await fetch(`${httpBase}/sessions/mine`, {
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined);
      if (probe?.status === 401) {
        handleAuthExpired();
        return;
      }
      // Token's fine — the SESSION itself is what's unreachable. Same
      // self-heal this app already applies for the "unknown session"
      // WS-level error frame (handleFrame below): a reconnect to a
      // KNOWN session (sessionPath !== 'new') that never opened means
      // the gateway rejected it outright — e.g. services/gateway's
      // canAccessSession() 403ing a sessionId whose ownership row no
      // longer exists (hit for real: a full DB migration that started
      // the new database empty left every browser's cached session id
      // pointing at a row that's just gone). Retrying the exact same
      // id would 403 forever, leaving the user stuck
      // rejecting-and-reloading with no way out — drop the stale id
      // (back to `/`, `replaceState` since this is a correction the
      // app is making, not a click) and start fresh instead of
      // looping. Bounded to exactly 1 retry: the retry itself passes
      // 'new', so a second failure just falls through to
      // 'disconnected' below.
      if (sessionPath !== "new") {
        replaceHomeUrl();
        setHasChatted(false);
        toast.info(t("app.sessionGoneStartedNew"));
        connect(httpBase, token, "new");
        return;
      }
      // Genuine give-up for THIS connect attempt (token's fine per the
      // probe above, but the socket still never opened — gateway
      // unreachable, network down, ...). If this was the initial
      // silent auto-reconnect, stop showing the loading screen and
      // fall back to the real login form rather than spinning forever.
      setStatus("disconnected");
      setAuthCheckPending(false);
    }

    socket.addEventListener("close", () => {
      // Guards against a STALE close event: switchSession()/startNewSession()
      // close the OLD socket right before opening a new one, and 'close'
      // doesn't fire synchronously — by the time it does, wsRef.current may
      // already point at the NEW (already-open) socket. Only a close of the
      // CURRENTLY active socket means "really disconnected".
      if (wsRef.current !== socket) return;
      wsRef.current = null;
      if (!didOpen) {
        // The 'error' grace timer above may have already handled this
        // (rare but possible ordering: its 300ms timer fires before
        // 'close' does, just not so far ahead that this guard is
        // pointless — real WS implementations that DO follow the spec
        // fire 'close' right after 'error', well under 300ms).
        if (handshakeSettled) return;
        handshakeSettled = true;
        void handleHandshakeFailure();
        return;
      }
      setStatus("disconnected");
    });

    socket.addEventListener("message", (ev) => {
      // Bug fix 2026-09-09 (docs/security-performance-review-2026-09-09.md's
      // Bug #1 — the most-worth-fixing one in that list): the SAME stale-event
      // race the 'close' handler above already guards against
      // (`wsRef.current !== socket`) — switchSession()/startNewSession()
      // close the OLD socket right before opening a new one, and a
      // `message` event already in flight on the old socket can still land
      // AFTER `wsRef.current` has moved on to the new one. Without this
      // guard, that stale frame gets published into the shared
      // frameHistoryRef/listeners as if it belonged to the NEW session —
      // a real message/tool-result from session A could bleed into
      // session B right after switching. Same guard, same reasoning.
      if (wsRef.current !== socket) return;
      let frame: ServerToClient;
      try {
        frame = JSON.parse(String(ev.data)) as ServerToClient;
      } catch {
        console.error(
          "fox-harness-web: invalid JSON frame from gateway",
          ev.data,
        );
        return;
      }
      handleFrame(frame);
    });
  }

  function handleFrame(frame: ServerToClient): void {
    switch (frame.type) {
      case "session":
        // Deliberately does NOT touch the URL here — receiving a `session`
        // frame just means a session id was assigned, not that it has any
        // real content yet. The URL only transitions to `/chat/<id>` at
        // the moment a real message is actually sent (`runtime.send` below)
        // — the whole point of this feature (hide session state until
        // there's something real behind it).
        setSessionId(frame.sessionId);
        break;
      case "error":
        if (/unknown session/i.test(frame.message)) {
          replaceHomeUrl();
          setHasChatted(false);
        }
        break;
    }
    publishFrame(frame);
  }

  // No UI picker anymore (2026-09-08, docs/code-rules.md §36) — this just
  // seeds `selectedModel` with the first model the gateway allows, so a new
  // session still gets a real value in `connect()`'s `&model=` param.
  async function pickDefaultModel(httpBase: string): Promise<void> {
    if (!httpBase) return;
    try {
      const res = await fetch(`${httpBase}/models`);
      if (!res.ok) return;
      const body = (await res.json()) as { models: string[] };
      setSelectedModel((previous) =>
        body.models.includes(previous) ? previous : (body.models[0] ?? ""),
      );
    } catch (error) {
      console.error("fox-harness-web: failed to fetch models", error);
    }
  }

  function startNewSession(flow?: string): void {
    // Real bug fixed 2026-09-10: clicking "New chat" while already on a
    // fresh, never-chatted session (`!hasChatted`) used to close the
    // current socket and open ANOTHER brand-new one anyway — a real
    // orchestrator session nobody would ever send a message into, created
    // for nothing every time someone clicked it more than once before
    // typing. `hasChatted` is the exact signal that already answers "is
    // there real content behind the current session" everywhere else in
    // this file (URL routing, the session-id display) — reusing it here
    // instead of inventing a second way to ask the same question. Already
    // on an empty new chat -> this is a no-op, matching real chat
    // platforms (clicking "New chat" there doesn't spawn a second empty
    // conversation either).
    // docs/data-analysis-flow-plan.md: this no-op guard only makes sense for
    // "New chat" re-clicked on its own empty session — an explicit `flow`
    // request (the "Phân tích dữ liệu" button) always means "switch to a
    // session on THIS flow", even from an empty default-flow one, so it
    // skips the guard rather than silently doing nothing.
    if (!hasChatted && flow === undefined) return;
    const httpBase = gatewayHttpBaseRef.current;
    const token = localStorage.getItem(STORAGE_TOKEN);
    if (!token) return;
    // Real pushState — an explicit "New chat" click, so Back returns to
    // whatever chat was open before it, same category as switchSession
    // below.
    pushHomeUrl();
    setHasChatted(false);
    wsRef.current?.close();
    connect(httpBase, token, "new", flow);
  }

  const runtime: Runtime = useMemo(
    () => ({
      sessionId,
      userEmail,
      apiUrl: (path) => `${gatewayHttpBaseRef.current}${path}`,
      authHeaders: () => {
        const token = localStorage.getItem(STORAGE_TOKEN);
        const headers: Record<string, string> = {};
        if (token) headers.authorization = `Bearer ${token}`;
        return headers;
      },
      authedFetch: async (path, init) => {
        const token = localStorage.getItem(STORAGE_TOKEN);
        const headers: Record<string, string> = {
          ...(init?.headers as Record<string, string> | undefined),
        };
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fetch(`${gatewayHttpBaseRef.current}${path}`, {
          ...init,
          headers,
        });
        if (res.status === 401) handleAuthExpired();
        return res;
      },
      onFrame: (listener) => {
        for (const frame of frameHistoryRef.current) listener(frame);
        frameListenersRef.current.add(listener);
        return () => frameListenersRef.current.delete(listener);
      },
      send: (frame) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          // The actual trigger for the whole feature: the ONLY place the
          // URL transitions from `/` to `/chat/<id>` — right as a real
          // message is sent, exactly mirroring the backend's own
          // `first_message_at` trigger (services/gateway/src/db.ts's
          // `markSessionFirstMessage`, set the first time a real
          // client->worker frame passes through). `replaceState`, not
          // `pushState` — see the helper's own comment for why.
          if (!hasChatted && sessionId) {
            replaceChatUrl(sessionId);
            setHasChatted(true);
          }
          wsRef.current.send(JSON.stringify(frame));
        }
      },
      switchSession: (id) => {
        const token = localStorage.getItem(STORAGE_TOKEN);
        if (!token || !gatewayHttpBaseRef.current) return;
        // Real pushState — an explicit click. Anything reachable from the
        // sidebar list already has `first_message_at` set server-side, so
        // showing its id right away is correct, not a violation of the
        // "hide until chatted" rule.
        pushChatUrl(id);
        setHasChatted(true);
        wsRef.current?.close();
        connect(gatewayHttpBaseRef.current, token, id);
      },
      newSession: startNewSession,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, userEmail, hasChatted],
  );

  function handleLogin(email: string, password: string): void {
    setConnectError(null);
    const httpBase = gatewayUrl.trim().replace(/\/$/, "");
    void (async () => {
      try {
        const result = await login(httpBase, email, password);
        localStorage.setItem(STORAGE_EMAIL, result.email);
        setUserEmail(result.email);
        // Resumes whatever `/chat/<id>` is currently in the address bar —
        // this is what makes a deep link work while logged out: the URL
        // stays as typed/bookmarked through the login screen, no
        // special-casing needed.
        connect(httpBase, result.token, sessionIdFromUrl() ?? "new");
      } catch (error) {
        setConnectError(
          error instanceof AuthError
            ? translateErrorCode(t, error.code, error.message)
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    })();
  }

  // Returns whether it succeeded so ConnectForm can switch itself back to
  // login mode (real gap fixed 2026-09-08: this used to be fire-and-forget,
  // reusing the error slot for a success string — the form stayed in
  // "Create account" mode afterward, so the very next click just tried to
  // register the same address again instead of logging in with it).
  async function handleRegister(
    email: string,
    password: string,
  ): Promise<boolean> {
    setConnectError(null);
    const httpBase = gatewayUrl.trim().replace(/\/$/, "");
    try {
      await register(httpBase, email, password);
      return true;
    } catch (error) {
      setConnectError(
        error instanceof AuthError
          ? translateErrorCode(t, error.code, error.message)
          : error instanceof Error
            ? error.message
            : String(error),
      );
      return false;
    }
  }

  function handleLogout(): void {
    const httpBase = gatewayHttpBaseRef.current;
    const token = localStorage.getItem(STORAGE_TOKEN);
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("disconnected");
    // Clears BOTH the local copy (localStorage, 2026-09-10 — so no reload,
    // in THIS tab or any other tab of this browser, silently reconnects
    // with the token this button just revoked) and the server-side one (so
    // the token can't be replayed from anywhere else either). The URL is
    // cleared too (real correctness gap caught while implementing, not
    // just carried over from the old code): a different account logging in
    // on the SAME tab reads whatever `/chat/<id>` is in the address bar
    // (`handleLogin` above) — without this, a second account would try to
    // resume the FIRST account's session id, which does fail safely (403 →
    // the existing self-heal redirects home) but with a confusing
    // "previous session no longer available" toast on what should just be
    // a normal fresh login.
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_EMAIL);
    setUserEmail("");
    setAuthenticated(false);
    replaceHomeUrl();
    setHasChatted(false);
    if (httpBase && token) void logoutRequest(httpBase, token);
  }

  // Auto-reconnect on load if this BROWSER already authenticated —
  // localStorage (2026-09-10, was sessionStorage) survives a reload AND is
  // shared across every tab of this origin, so a brand-new tab picks up
  // the same login a different tab already has. Only an explicit logout
  // (or the server revoking the token) clears it.
  useEffect(() => {
    const storedToken = localStorage.getItem(STORAGE_TOKEN);
    const storedGateway = localStorage.getItem(STORAGE_GATEWAY);
    // A `/chat/` path that fails the UUID check (garbage, typo, truncated
    // link) is a correction the app makes, not a click — replaceState,
    // clean it up before connecting fresh rather than leaving it dangling.
    if (location.pathname.startsWith("/chat/") && !sessionIdFromUrl())
      replaceHomeUrl();
    if (storedToken && storedGateway) {
      connect(storedGateway, storedToken, sessionIdFromUrl() ?? "new");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real Back/Forward support (2026-09-09) — without this, the URL would
  // change on popstate but the visible app wouldn't follow it, defeating
  // the point of a real URL. Re-derives the target from whatever the URL
  // says now and reconnects to it, same as a fresh `switchSession`/
  // `startNewSession` would.
  useEffect(() => {
    function onPopState(): void {
      const token = localStorage.getItem(STORAGE_TOKEN);
      if (!token || !gatewayHttpBaseRef.current) return;
      const target = sessionIdFromUrl();
      setHasChatted(!!target);
      wsRef.current?.close();
      connect(gatewayHttpBaseRef.current, token, target ?? "new");
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // GET /models needs no auth (services/gateway's own comment on that route
  // explains why) — populated once on load, before any login happens.
  useEffect(() => {
    void pickDefaultModel(gatewayUrl.trim().replace(/\/$/, ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real bug fixed here (found while restructuring the entry flow, below):
  // this effect used to run once on mount with an EMPTY dependency array —
  // fine when `#app` was always in the DOM, but now that it only mounts
  // AFTER `authenticated` becomes true (see the return statement), the ref
  // was still null the one time this effect ever ran, so the observer never
  // attached at all. Depending on `authenticated` re-runs it the moment
  // `#app` actually exists — and only then, since (2026-09-09) a mere WS
  // reconnect no longer unmounts `#app` at all, so this must NOT depend on
  // `status` (it would otherwise briefly stop observing on every
  // switchSession/startNewSession/popstate for no reason).
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setViewportWidth(el.getBoundingClientRect().width),
    );
    observer.observe(el);
    setViewportWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [authenticated]);

  const narrow = viewportWidth < SIDEBAR_AUTO_COLLAPSE;
  // Phase 15 (2026-09-08): wide viewports can now ALSO collapse — a real
  // user preference (`sidebarPinnedCollapsed`), not just narrow's
  // space-constrained auto-collapse. `toggleSidebarCollapse` is reachable
  // from the sidebar's own collapse control regardless of viewport width —
  // the header used to also have a separate narrow-only hamburger reaching
  // the same state, removed 2026-09-10 along with the rest of `#header`
  // (redundant: the sidebar's own toggle already stays visible in rail
  // mode on any viewport, docs/code-rules.md's 2026-09-09 fix). Gated on
  // `authenticated`, not `status === 'connected'` (2026-09-09 fix) — a
  // transient WS reconnect used to flip this to `false` for a moment,
  // flashing the sidebar to its expanded width on every session switch.
  const sidebarCollapsed =
    authenticated &&
    (narrow ? !sidebarManuallyExpanded : sidebarPinnedCollapsed);
  function toggleSidebarCollapse(): void {
    if (narrow) {
      setSidebarManuallyExpanded((v) => !v);
      return;
    }
    setSidebarPinnedCollapsed((v) => {
      const next = !v;
      localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED, next ? "1" : "0");
      return next;
    });
  }
  const cols = computeColumns(
    viewportWidth,
    sidebarCollapsed ? 0 : SIDEBAR_EXPANDED_WIDTH,
    0,
  );
  const gridTemplateColumns = `${cols.sidebar}px ${cols.center}px`;

  // Follow-up (2026-09-08): a real, previously-undiscovered UX gap — the
  // login/register form used to render INSIDE the same grid frame as the
  // connected app (sharing #header, packed next to a "Gateway URL"/"Model"
  // technical form), so the very first thing anyone ever saw looked like a
  // debug form, not a real product entry screen — a user correctly
  // described this as "the flow is wrong". Now split cleanly: not
  // authenticated -> a dedicated, centered auth screen (no sidebar, no
  // header, no grid math at all); authenticated -> the real app frame,
  // exactly as before. Gated on `authenticated` rather than `status ===
  // 'connected'` since 2026-09-09 ("lúc move giữa 2 route có reload giật")
  // — see `authenticated`'s own comment by its `useState` above for why a
  // plain WS reconnect must NOT swap back to this screen.
  if (!authenticated) {
    // Real gap fixed 2026-09-10 ("lúc quay lại web khi đang check token
    // nên có màn loading để tránh hiện form login") — see
    // `authCheckPending`'s own comment above for the full lifecycle. No
    // `.fh-auth-screen-controls` (theme/language) here on purpose — this
    // screen is only ever up for the brief, uninterruptible window while
    // the silent reconnect is in flight, not somewhere a user is expected
    // to sit and want to change settings.
    if (authCheckPending) {
      return (
        <div className="fh-auth-screen">
          <div className="fh-auth-loading">
            <div className="fh-spinner" />
          </div>
        </div>
      );
    }
    return (
      <div className="fh-auth-screen">
        <div className="fh-auth-screen-controls">
          <LanguageSelect />
          <ThemeToggle />
        </div>
        <ConnectForm
          error={connectError}
          connecting={status === "connecting"}
          onLogin={handleLogin}
          onRegister={handleRegister}
        />
      </div>
    );
  }

  return (
    <RuntimeContext.Provider value={runtime}>
      <div
        id="app"
        className="fh-app-frame"
        ref={frameRef}
        style={{ gridTemplateColumns }}
      >
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebarCollapse}
          onNewSession={() => startNewSession()}
          onNewDataAnalysisSession={() => startNewSession("data-analysis")}
          newSessionDisabled={!hasChatted}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSkills={() => setSkillsOpen(true)}
          onLogout={handleLogout}
        />
        <div id="center-col" className="fh-center-col">
          <Conversation />
        </div>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLogout={handleLogout}
      />

      <SkillsDialog open={skillsOpen} onClose={() => setSkillsOpen(false)} />
    </RuntimeContext.Provider>
  );
}
