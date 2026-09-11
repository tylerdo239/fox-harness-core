# apps/web

**One single, normally-built React app, shared by every user (2026-09-08).**
Not a plugin host, not a manifest-driven shell — just an ordinary React SPA.
`public/` is the entire deployable artifact: build it once, serve it from
any static host, every user gets the same bundle.

This replaces an increasingly elaborate per-session, dynamically-composed
UI-plugin delivery mechanism built up across Phases 4-12 (a boot manifest, a
shared module loader, per-plugin `client.js` bundles fetched via dynamic
`import()`, a slots outlet router). That mechanism kept causing real
loading/caching bugs that were genuinely hard to diagnose without a browser
devtools session — the user decided it wasn't worth the complexity and asked
for it removed entirely, in favor of one plain app. Every real FEATURE those
phases built (theme, chat/composer/command-palette, session list, plugin
enable/disable, plugin inventory, model picker, settings dialog) survives —
see Design below for where each one lives now. The old design reasoning and
real dsh research behind them is preserved for the historical record in
`docs/agent-core-architecture-roadmap.md` and `docs/code-rules.md` §18-§27
(not deleted); the removal itself is `docs/code-rules.md` §30.

## Design

- **`src/main.tsx`** — the only entry point: `createRoot(#root).render(<App/>)`.
- **`src/App.tsx`** — the composition root. Owns auth (register/login/logout),
  the WebSocket connection lifecycle, the frame pub/sub every component reads
  from, and the responsive 2-column layout (`dsh-client-ui-layout`'s real
  `computeColumns` algorithm, ported verbatim from the old shell — same
  1024px breakpoint, same 56px rail width, no drag-to-resize).
- **`src/runtime.ts`** — `RuntimeContext`, a plain React Context (`useRuntime()`)
  that every component below reads/writes through: `sessionId`, `apiUrl()`,
  `authHeaders()`, `authedFetch()` (2026-09-09 — wraps `fetch`+`authHeaders`
  and triggers the shared "kicked back to login" flow on a real `401`
  instead of the call site silently swallowing it; every real fetch call
  site uses this now, not raw `fetch()`, see `docs/code-rules.md` §52),
  `onFrame()`/`send()` (wire protocol), `switchSession()`, `newSession()`.
  Replaces the old `window.__FOX_HARNESS__` global — that existed only
  because separately-loaded bundles couldn't share a module graph; a single
  app can just pass a normal Context down.
- **`src/wire.ts`** — the wire-protocol types (`ServerToClient`, content
  blocks, stream chunks, ...), shared by every component that needs them.
  Used to be duplicated across separate packages ("mirrored, not imported" —
  each was an independently-loaded bundle); one shared file is simply
  correct now, not a compromise.
- **`src/components/`** — `primitives/` + `features/`, the latter grouped
  by real layout/page section (`docs/code-rules.md` §61, revised §67,
  regrouped §71 — user asked for `features/` itself to stop being flat
  and split by which part of the app each file actually renders in,
  derived from real import/render relationships, not guessed):
  - **`primitives/`** — genuinely generic, stateless, presentational —
    `Button.tsx`, `IconButton.tsx`, `MenuItem.tsx`, `SelectableCard.tsx`,
    `Input.tsx`. None of these know anything about this app's domain; any
    of them could be lifted into an unrelated project unchanged. §61 had
    first put `ThemeToggle`/`LangToggle` here, but user feedback correctly
    called that out as not actually primitive — both own a real
    app-specific hook (`useTheme()`/`useLocale()`). §67's own real
    finding: ~10 different files had each hand-rolled their own
    button/input CSS class for the exact same handful of underlying
    shapes (a circular icon button, an icon+label menu row, a bordered
    choice card, a pill CTA in 4 color variants) — collapsed into these 5
    components + `variant`/`size` props, not a redesign (every pixel
    value carried over verbatim from whichever old class it replaced,
    verified in `public/style.css`'s own "Real primitives" section
    comment).
  - **`features/auth/`** — only ever rendered together, on the pre-login
    `.fh-auth-screen` (`App.tsx`):
    - `ConnectForm.tsx` — the pre-login card (login/register). Register
      mode has a real confirm-password field and 3 distinct client-side
      validation messages (email required, password too short, passwords
      don't match — 2026-09-10) checked before the server is ever called,
      instead of the old single combined server message.
    - `ThemeToggle.tsx` — explicit light/dark control. `theme.css` always
      had full values for both (Phase 4/14) and a `[data-theme]` override
      hook, but nothing ever set the attribute — dark only ever applied
      automatically via `prefers-color-scheme`. Does not persist anything
      until the user actually clicks it (follows the OS live until then).
      Paired with `src/useTheme.ts`; renders through
      `primitives/IconButton.tsx`. `LangToggle.tsx`, which used to render
      right next to this, is REMOVED (2026-09-10) — replaced everywhere
      by `LanguageSelect.tsx` (below), a real dropdown instead of a plain
      toggle button.
  - **`features/`** (flat, directly here) — `LanguageSelect.tsx`
    (2026-09-10): replaces what used to be a bare native `<select>` in
    Settings (deliberately left native at §67 — 1 use site, CSS already
    shared — but the user pointed out it genuinely had no real UI of its
    own, especially sitting right below the Theme picker's 2 real styled
    cards) AND `LangToggle.tsx` on the auth screen — one real dropdown
    (trigger + a real popup, reusing `primitives/MenuItem.tsx` for its 2
    rows) instead of 2 different controls in 2 places. Portaled to
    `document.body`, mirroring `AccountMenu.tsx`'s own proven pattern —
    its container has `overflow-y: auto` when opened from Settings
    (`.fh-settings-content`), which risked the same clipping problem
    `#sidebar-col` posed for AccountMenu. Sits directly under `features/`,
    not inside `auth/` or `settings/`, because it's a real second consumer
    in an unrelated section — same "group by real usage" rule that
    organized this folder in the first place (§71) says a file with 2
    unrelated parents doesn't belong to either.
  - **`features/sidebar/`** — the sidebar and its own real children (no
    other file imports these 2):
    - `Sidebar.tsx` — shell chrome: a brand row (mark + name + collapse
      toggle), a "New chat" CTA (renamed from "New session" 2026-09-10,
      matching the button's real behavior — clicking it while already on
      an empty unchatted session is now a real no-op instead of quietly
      spinning up a second unused backend session), the search toggle,
      the session-list region, then the account row (`AccountMenu`). Can
      collapse to a 56px rail on wide viewports too (a real persisted
      preference, `localStorage['fox-harness/sidebarCollapsed']`), not
      just narrow ones.
    - `HistoryChat.tsx` (renamed from `SessionList.tsx` 2026-09-10 — user
      called out that "session" is a backend/routing concept elsewhere in
      this app, not what this component is to the user: their chat
      history) — the sidebar's chat history list, grouped by real date
      ("Today"/"Yesterday"/"Previous 7 Days"/"Previous 30 Days"/"Older" —
      no workspace/folder grouping, this project has no directory concept,
      just real `updatedAt` buckets), client-side substring search on
      title (the `query` itself is a prop — the search toggle/input UI
      lives in `Sidebar.tsx`'s own logo row). Real bug fixed the same
      day ("chọn 1 trong các đoạn chat list này sẽ bị nhảy" — see
      `docs/code-rules.md` §73): opening an old chat used to re-sort it to
      the top of "Today" the instant it was clicked (`services/gateway`
      bumped `updated_at` on bare WS connect, not just real activity) — the
      row visibly jumped out from under the cursor. Fixed server-side, not
      here. Each row's hover-revealed action button is now a `MoreIcon`
      ("...", 2026-09-10, `docs/code-rules.md` §74-75 — was a bare Rename
      pencil) opening a real 2-item popup to its RIGHT (Rename, Delete —
      same portal+dismiss pattern as `AccountMenu.tsx`). Delete calls
      `services/gateway`'s existing real `DELETE /sessions/:id` (already
      there from Phase 6, just never wired to this list before); deleting
      the currently-open chat hands off to `runtime.newSession()`. Rename
      no longer opens a `window.prompt` — it turns the row's own title into
      a real inline `<input>` (current title pre-filled/selected, Enter
      commits, Escape/blur cancels), with a real client-side check against
      this app's actual `sessions.title varchar(255)` column width (a
      toast, not a silent truncation) before ever calling the server —
      `services/gateway`'s own PATCH handler got the matching real 400 at
      the same limit, replacing a stale, mismatched silent `.slice(0, 200)`
      this surfaced.
    - `AccountMenu.tsx` (2026-09-10) — the sidebar's account row no longer
      opens `SettingsDialog` directly; it opens a small popup above itself
      (Settings, Logout — matching chat.deepseek.com/claude.ai) with a
      trailing "..." affordance on the trigger. Portaled to
      `document.body` via `createPortal` — `#sidebar-col`'s real
      `overflow: hidden` (needed for the rail-collapse animation) would
      otherwise clip the popup, especially in rail mode. This app's first
      portal/popover; dismisses on an outside click or Escape.
  - **`features/conversation/`**:
    - `Conversation.tsx` — chat log + composer. Before any message exists,
      shows a real centered empty state (heading + the SAME composer, just
      enlarged) instead of an empty `#log` pinned above a bottom bar.
      Deliberately does NOT clone Instant/Expert/Vision mode tabs from a
      real chat.deepseek.com screenshot — fox-harness has no multi-mode
      concept (one fixed model per session), so those would be fake UI
      with nothing real behind them; the user confirmed skipping them when
      asked directly. Casual redesign, 3 rounds the same day (2026-09-10,
      `docs/code-rules.md` §79-81, starting from "hide hết và làm UI UX
      lại cho casual như các platform ai agent"), ending state:
      - No `turn {n}` divider — used to appear at every turn boundary
        (including the first, nothing to divide from) — real consumer AI
        chat platforms show no turn/message-count chrome at all.
      - No `steer` checkbox — every send is a real `followup` now.
        `steer` stays a real `wire.ts` capability, just not exposed in
        this UI.
      - `tool/call`/`tool/result` render as 1 collapsible pill per tool
        call (`→ used {tool}`, collapsed by default, click to see
        args/result) instead of 2 separate always-expanded monospace
        cards — correlated by the real `callId`/`toolCallId` fields
        (confirmed against the installed `dsh-session`/`dsh-llm` `.d.ts`
        files, not guessed) so a result always completes the right pill
        even with several tool calls in flight in the same turn.
      - No reasoning/chain-of-thought UI at all — briefly got the same
        collapsed-pill treatment as tool calls (§80), then removed
        entirely per the user's own follow-up (§81) once they'd tried the
        collapsed version and decided against it; `reasoning-delta` chunks
        aren't even accumulated into state anymore, not just hidden.
      - No `/`-triggered command palette (`/new`, `/rename`) — removed
        entirely (§81); both actions already have real dedicated UI
        elsewhere (Sidebar's "New chat" button; HistoryChat's own row
        rename, §75) that this duplicated.
      - The assistant's reply no longer renders inside a `.bubble` at all
        — only `.bubble-user` still does — matching real claude.ai/
        ChatGPT/Gemini/chat.deepseek.com convention (user = a bubble,
        assistant = plain flowing text, no container).
      - `#text-input` (the composer's own field) has no border in any
        state, including focus (no accent-colored focus border) — every
        OTHER text input in the app keeps the shared base rule's real
        border/focus-color untouched.
  - **`features/settings/`**:
    - `SettingsDialog.tsx` — a real modal (mask/panel/heading) with a real
      left nav rail, 2 tabs (2026-09-10, after the user shared 2 real
      claude.ai Settings screenshots): **General** (the Theme picker —
      `useTheme.ts`'s `setTheme()`, 2 real cards, not the header's 2-way
      toggle's `toggle()` — and the Language picker, `LanguageSelect.tsx`
      — see `features/` above, not a child of this folder anymore since
      it also renders on the auth screen) and **Profile** (real email + a
      real Logout button,
      right-aligned at the end — the same `handleLogout` AccountMenu's
      popup already calls, a second real entry point to the same action).
      Deliberately does NOT clone the reference screenshot's Name/Phone/
      Role/"log out of all devices"/"delete account" — this app's `users`
      table has no name/phone column and no backend capability to revoke
      every token for a user or delete an account at all; a Role row
      briefly existed and was removed the same day once it turned out not
      to be wanted. Confirmed every one of these cuts with the user rather
      than shipping UI with nothing real behind it (same reasoning as
      Conversation.tsx's own note on not cloning chat.deepseek.com's fake
      Instant/Expert/Vision mode tabs). `PluginInventory.tsx` (the live
      Cordis Loader diagnostic that briefly lived in the General tab) is
      REMOVED entirely, same day — the user asked for it gone from
      Settings, and nothing else ever mounted it, so the file itself is
      deleted, not left as dead code. The (unrelated) plugin catalog
      enable/disable toggle that used to live here is ALSO removed, much
      earlier (Phase 16, `docs/agent-core-architecture-roadmap.md`) — real
      need turned out to be "every user gets the same fixed capability
      set," not "each user/session picks their own."
- **Toasts** — real `sonner` (a real, actively-maintained library, not
  hand-rolled — `docs/code-rules.md` §39), `<Toaster/>` rendered by
  `App.tsx`, `toast.success(...)` called directly from anywhere (e.g.
  `ConnectForm.tsx` after a successful registration) with no
  context/prop-drilling needed. Themed via CSS variable overrides in
  `public/style.css` pointed at this app's own tokens, not sonner's
  built-in palette — `public/sonner.css` (sonner's own real compiled
  stylesheet) is copied from `node_modules` on every build by
  `scripts/build-web.mjs`, never hand-maintained, so it can't drift out of
  sync with whatever version is actually installed.
- **`public/theme.css`** — design tokens (`--fh-*`), a real static
  stylesheet now (used to be a UI plugin that injected a `<style>` tag at
  runtime). Brand accent is `#F37021` (orange, user-specified 2026-09-08,
  `docs/code-rules.md` §40) in both light and dark — `--fh-accent-contrast`
  (button text) and the new `--fh-alias-accent-text` (accent used AS text
  on the page's own surface, e.g. the login-mode toggle link) are darker
  derived shades, picked from real computed WCAG contrast ratios rather
  than guessed, since plain white-on-orange and plain orange-on-light-
  surface both fail AA's 4.5:1.
- **`public/style.css`** — shell layout/structure, reads every color value
  through `var(--fh-*, <fallback>)`.

Talks to `services/gateway`'s real wire protocol directly (`src/wire.ts`,
mirrored from `packages/transport`'s real shapes, not imported — this
package still has zero dependency on any `@fox-harness/*` package):
`POST /auth/{register,login,logout}` for accounts, then `/sessions/new` /
`/sessions/<id>` over WebSocket for `{session|snapshot|event|error}` frames
and `{followup|steer}` commands. See `services/gateway/README.md` and
`packages/transport/README.md` for the authoritative protocol docs.

## Build

```
pnpm run build   # from the repo root: tsc -b (typecheck) then
                  # scripts/build-web.mjs (esbuild — one IIFE bundle,
                  # React embedded normally, no external/module-loader
                  # tricks needed since there's only one bundle now)
```

`tsc -b`'s own `.js`/`.d.ts` output goes to `lib/` (gitignored, same
convention every other package in this repo uses) — it's pure type-check
byproduct, thrown away, not what actually ships. `public/` holds only the 5
real files the app needs: `index.html`, `main.js` (the real esbuild
bundle), `theme.css`, `sonner.css`, `style.css`. (2026-09-08 fix,
`docs/code-rules.md` §44 — `apps/web/tsconfig.json` used to point `outDir`
at `public` itself, so every `tsc -b` run dumped 19 stray, genuinely
HTTP-servable files — `App.js`, `components/*.js`, `.tsbuildinfo`, ... —
straight into the same directory `scripts/serve-web.mjs` serves live.)

Then serve `public/` — **`node scripts/serve-web.mjs`** (repo root, port
5173 by default, `PORT=` to override), not a generic static server. Real
reason this matters, not just a preference: a plain `python3 -m
http.server` sends no `Cache-Control` header at all, so browsers apply
their own heuristic caching and can keep showing an OLD `main.js`/`style.css`
after a rebuild even on a normal reload — confirmed twice in this project
(`curl` proved the server was serving fresh bytes both times; the browser
just wasn't asking for them). `scripts/serve-web.mjs` sends
`Cache-Control: no-store` on every response specifically to make that whole
class of problem impossible — see `docs/code-rules.md` §29.

Before login, the whole viewport is a dedicated `.fh-auth-screen` (no
`#app` grid, no `#header` — those only mount once `connected`, 2026-09-08
redesign, `docs/code-rules.md` §34): a card with just email/password and a
login/register mode toggle (`#register-button`) — nothing else. Gateway URL
and Model used to live behind a collapsed "Advanced" disclosure on that
same card; both were removed entirely (2026-09-08 follow-up,
`docs/code-rules.md` §36) — neither belongs on a login screen, even hidden.
The gateway still resolves the same way under the hood (`?gateway=` in the
page URL, else `http://localhost:4000` — `App.tsx`'s `defaultGatewayUrl()`),
just with no UI control anymore; a new session still gets a real model
automatically (the first entry `GET /models` returns, `pickDefaultModel()`),
it just can't be chosen from the UI.

## Client-side persistence

- `localStorage`: the auth token (`fox-harness/token`, was `sessionStorage`
  until 2026-09-10 — see below for why that was a real bug, not a
  preference) — a reload OR a brand-new tab of this browser does not
  require logging in again (cleared on a real Logout click —
  `services/gateway`'s `POST /auth/logout` revokes it server-side too, so
  a stale copy anywhere else self-heals via the existing 401/handshake
  handling, not a new mechanism). `fox-harness/email` lives alongside it
  (2026-09-08 — `services/gateway`'s `/auth/login` response gained
  `email`, cleared on logout too) so a reload/new tab still knows who's
  logged in for the sidebar's account footer. Also the sidebar's
  collapse-to-rail preference on wide viewports
  (`fox-harness/sidebarCollapsed`) and the light/dark theme override
  (`fox-harness/theme`) — real user preferences, not per-tab state, so
  they survive across tabs/reloads too.
  - **Real bug fixed 2026-09-10** ("khi mở tab mới app bắt login lại"):
    the auth token was `sessionStorage` (tab-scoped, not just
    browser-session-scoped) until this — a brand-new tab of the SAME
    already-logged-in browser had no token at all and got bounced to the
    login screen. Real chat platforms don't do this: being logged in on
    one tab means being logged in on every tab. Moved to `localStorage`
    for exactly that sharing; nothing else about the design needed to
    change (per-tab state like which session is showing already lives in
    the URL, not in this key, so multiple tabs sharing one token doesn't
    reintroduce the "tabs fight over the current session" bug the URL
    migration fixed — see below).
  - **Real gap fixed 2026-09-10** ("lúc quay lại web khi đang check token
    nên có màn loading để tránh hiện form login", `docs/code-rules.md`
    §82): a reload/new tab with a stored token used to flash the real
    login form for the brief window between mount and the silent
    auto-reconnect's WS actually opening. `authCheckPending`
    (`App.tsx`) starts `true` only when a token is actually stored (a
    genuinely logged-out visitor sees the login form immediately, no
    fake delay) and gates a real spinner (`.fh-spinner`, this app's
    first CSS `@keyframes`) in place of `<ConnectForm>` until the
    reconnect reaches a definitive answer. Testing this surfaced a real,
    separate, pre-existing bug in `services/gateway`'s WS-upgrade
    rejection (`socket.write('HTTP/1.1 401...'); socket.destroy()` — a
    raw socket teardown, not a real WS close handshake): confirmed
    directly against the real gateway that Node's `WebSocket` client
    fires `error` for it but never fires `close` at all. `connect()`'s
    whole failure-handling path used to live ONLY in the `close`
    handler on the (now-disproven) assumption that close always follows
    error — this bug was invisible before because `!authenticated`
    already defaulted to showing the login form regardless; the new
    loading screen depends on that same signal actually arriving, which
    is what made it visible. Fixed by factoring the failure handling
    into `handleHandshakeFailure()`, reachable from both the real
    `close` event and a 300ms grace timer on `error` (guarded against
    double-running by a `handshakeSettled` flag) — not a workaround for
    the loading screen specifically, a real fix to `connect()`'s own
    reconnect-failure detection.
- **The URL** (`/` or `/chat/<id>`, 2026-09-09): which session a reload
  reconnects to — replaces what used to be a `localStorage` key
  (`fox-harness/sessionId`). The URL is strictly better for this: it's
  shareable/bookmarkable, and scopes correctly to one tab instead of
  leaking across every tab of the origin the way `localStorage` did (a
  real bug the old approach had — two tabs used to fight over the same
  "current session"). Deliberately stays at `/` — no session-specific
  detail in the address bar or anywhere in the UI — until a session's
  first real message is actually sent, mirroring
  `services/gateway`'s own `sessions.first_message_at` rule that already
  keeps an unchated session out of `GET /sessions/mine`.

## Verified end-to-end (2026-09-08)

Real, layered, no mocks: (1) a real Node WS/HTTP client — register, login, a
real chat turn completing through the full gateway → orchestrator → Docker
worker chain, `GET /sessions/mine`, `PATCH` rename, `GET /plugin-inventory`
returning real rows with zero `client-ui-*` modules left, the old
`GET /sessions/:id/manifest` route confirmed genuinely gone (404, not just
broken); (2) real jsdom + real React driving the ACTUAL built `main.js` —
no dynamic `import()` anywhere in it anymore (React is bundled directly, one
IIFE), so none of the jsdom `vm`/dynamic-import limitations hit in every
earlier phase's FE testing apply here at all: a real login-form submit (typed
credentials, real `submit` event) → sidebar/session-list/conversation all
appear → settings dialog opens with both real sections → `/re` shows the
command dropdown → a real Logout click clears storage AND gets the token a
genuine `401` afterward. Two real bugs found this way (not by TypeScript):
`packages/transport`'s `inject` array still requiring the just-deleted
`clientManifest` service (would have left the whole transport plugin
permanently pending, zero errors, just a WS port that never opens); several
new `<button>`s missing the `id` attributes `style.css` and this project's
own test scripts depend on. Full writeup: `docs/code-rules.md` §30.

Still never driven through an ACTUAL browser (no Claude in Chrome throughout
this project) — every verification here is real jsdom + real React against
the real built output, or a real Node client speaking the real protocol,
never an actual click-through.

## NOT yet done / known gaps

- No retry/backoff on the WebSocket connection — a dropped connection needs
  a manual reconnect (re-submit the connect form, or reload the page).
- A failed model call (missing credential, provider error) renders as a
  silent empty assistant bubble in `Conversation.tsx` — the `turn/end`
  reason IS available and already renders as a notice line, so the failure
  isn't fully silent, but there's no dedicated error state on the bubble.
- No rendering for `image` content blocks — text and reasoning only.
- `public/main.js` ships React's unminified development build (~1MB) — this
  project has no production-vs-dev build distinction anywhere yet.
