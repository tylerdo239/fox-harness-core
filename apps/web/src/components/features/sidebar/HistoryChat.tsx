// Sidebar's chat history list. Renamed from `SessionList.tsx` (2026-09-10,
// user: "SessionList tên vầy là ko chuẩn đây là HistoryChat") — "session" is
// a real backend/routing concept elsewhere in this app (services/gateway's
// `sessions` table, `runtime.sessionId`/`switchSession()`, the `/chat/<id>`
// URL) and stays named that everywhere it actually IS that; this component
// specifically is the user-facing chat history list, so it gets the
// user-facing name. Was `packages/client-ui-session-list`, a separately-
// loaded UI plugin bundle (Phase 12); now just a component in the one shared
// app (2026-09-08 follow-up). Client-side substring search on title — the
// actual search UI (toggle + input) lives one level up in Sidebar.tsx now
// (2026-09-08 follow-up, after the user shared a real chat.deepseek.com
// screenshot showing search in the sidebar's own logo row, not scoped
// inside the list) — this component just receives the current `query` and
// filters/groups against it.
//
// Real date grouping ("Today"/"Yesterday"/"Previous 7 Days"/"Previous 30
// Days"/"Older" — chat.deepseek.com's actual screenshot showed "Today" and
// "30 Days" headers) replaces the flat undifferentiated list this had
// before — still no workspace/folder concept (this project has none), just
// grouped by real `updatedAt`, not invented.
//
// Per-row "..." menu (2026-09-10, user: "hover sẽ hiện nút icon 3 chấm và
// dropdown có 2 option ... đổi tên và xoá") — the row used to expose a
// bare Rename pencil button directly on hover; replaced with a `MoreIcon`
// trigger that opens a real popup with 2 items (Rename, Delete), same
// portal+dismiss pattern `AccountMenu.tsx` established for exactly this
// "popup needs to escape an ancestor's `overflow`" problem. Delete proxies
// to services/gateway's existing real `DELETE /sessions/:id` route (Phase
// 6 checklist item 4 — already there, just never wired to this FE list
// before now). Only one row's popup is ever open at a time (`menuRow`
// holds the whole row, not just an id — the popup's own Rename/Delete
// handlers need the row's current title/sessionId, and looking it up again
// from `rows` by id would be redundant when the click handler already has
// it in hand).
//
// Same-day follow-up (user: "dropdown xuất hiện từ bên phải nút 3 chấm và
// khi ấn đổi tên biến title hiện tại thành ô input để nhập và ấn enter là
// xong"): popup now opens to the RIGHT of the trigger (was below-left) —
// see `openRowMenu`'s own comment. Rename no longer opens a `window.prompt`
// — clicking it turns the row's own title into a real inline `<input>`
// (current title pre-filled, selected), Enter commits, Escape/blur cancels.
// Real check added per the user's own explicit ask: title over 255 chars
// (this app's real `sessions.title` column width, `varchar(255)`) is
// rejected client-side with a toast BEFORE ever calling the server, same
// "validate client-side first" approach the register form already uses —
// also fixed a real, until-now-silent mismatch this surfaced:
// `services/gateway`'s PATCH handler used to silently `.slice(0, 200)` a
// too-long title instead of rejecting it, an arbitrary number that didn't
// even match the real 255-wide column — now a real 400 at the same limit
// the FE enforces, not a silent truncation to a made-up number.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { MoreIcon, PencilIcon, TrashIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
import { useRuntime } from "../../../runtime.ts";
import { IconButton } from "../../primitives/IconButton.tsx";
import { Input } from "../../primitives/Input.tsx";
import { MenuItem } from "../../primitives/MenuItem.tsx";

const TITLE_MAX_LENGTH = 255;

interface SessionRow {
  sessionId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  status: "running" | "hibernated" | "archived";
}

function rowLabel(
  row: SessionRow,
  t: (key: TranslationKey, params?: Record<string, string>) => string,
): string {
  return (
    row.title ?? t("historyChat.untitled", { id: row.sessionId.slice(0, 8) })
  );
}

// i18n (2026-09-10): this used to double as both the GROUPING key (the
// `Map` in `groups` below was keyed directly by these strings) and the
// DISPLAY label — translating the label in place would have silently
// broken the grouping itself (a `vi`-locale label would never match an
// `en`-locale bucket lookup). Split: `GROUP_ORDER` is now a stable,
// locale-independent internal key; `GROUP_LABEL_KEY` maps each to its
// translation key, looked up only at render time.
const GROUP_ORDER = ["today", "yesterday", "week", "month", "older"] as const;
type GroupKey = (typeof GROUP_ORDER)[number];

const GROUP_LABEL_KEY: Record<GroupKey, TranslationKey> = {
  today: "historyChat.groupToday",
  yesterday: "historyChat.groupYesterday",
  week: "historyChat.group7d",
  month: "historyChat.group30d",
  older: "historyChat.groupOlder",
};

const STATUS_LABEL_KEY: Record<SessionRow["status"], TranslationKey> = {
  running: "historyChat.statusRunning",
  hibernated: "historyChat.statusHibernated",
  archived: "historyChat.statusArchived",
};

function dayBucket(updatedAt: string, now: Date): GroupKey {
  const then = new Date(updatedAt);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const daysAgo = Math.floor(
    (startOfToday.getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      86_400_000,
  );
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo <= 7) return "week";
  if (daysAgo <= 30) return "month";
  return "older";
}

export function HistoryChat({ query }: { query: string }) {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [menuRow, setMenuRow] = useState<SessionRow | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuPopupRef = useRef<HTMLDivElement>(null);
  const [renamingRow, setRenamingRow] = useState<SessionRow | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  async function refresh(): Promise<void> {
    const res = await runtime.authedFetch("/sessions/mine");
    if (!res.ok) return;
    setRows((await res.json()) as SessionRow[]);
  }

  // Automatic titles: the worker's dsh-session-title appends a `session/title`
  // event (the first words of the first message); the sidebar shows the
  // gateway's `sessions.title`. Applied only from a live event and only while
  // the chat has no title — never over a user rename, and replaying an old chat
  // doesn't bump its `updated_at` (renaming does, which re-sorts the list).
  const sessionIdRef = useRef(runtime.sessionId);
  sessionIdRef.current = runtime.sessionId;

  async function applyAutoTitle(sessionId: string, title: string): Promise<void> {
    // The row appears only once gateway marks the first message, which can
    // land a moment after the title event.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await runtime.authedFetch("/sessions/mine");
      if (!res.ok) return;
      const list = (await res.json()) as SessionRow[];
      const row = list.find((r) => r.sessionId === sessionId);
      if (row) {
        if (row.title) return setRows(list);
        await runtime.authedFetch(`/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: title.slice(0, TITLE_MAX_LENGTH) }),
        });
        return refresh();
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  useEffect(() => {
    return runtime.onFrame((frame) => {
      if (frame.type !== "event" || frame.event.type !== "session/title") return;
      const data = frame.event.data as { title?: string; source?: { kind?: string } };
      if (data.title && data.source?.kind !== "user") {
        void applyAutoTitle(sessionIdRef.current, data.title);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // The active session isn't in `GET /sessions/mine`'s row set until its
    // first real WS connect commits a `sessions` insert (services/gateway's
    // WS upgrade handler) — refetch whenever the active session changes so
    // a brand-new session's row appears without a manual reload.
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.sessionId]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter((row) => rowLabel(row, t).toLowerCase().includes(q))
      : rows;
    const now = new Date();
    const byGroup = new Map<GroupKey, SessionRow[]>();
    for (const row of filtered) {
      const bucket = dayBucket(row.updatedAt, now);
      const list = byGroup.get(bucket);
      if (list) list.push(row);
      else byGroup.set(bucket, [row]);
    }
    return GROUP_ORDER.map((key) => ({
      key,
      label: t(GROUP_LABEL_KEY[key]),
      rows: byGroup.get(key) ?? [],
    })).filter((g) => g.rows.length > 0);
  }, [rows, query, t]);

  // Dismiss on an outside click or Escape — same pattern as
  // `AccountMenu.tsx`'s own popup.
  useEffect(() => {
    if (!menuRow) return;
    function onPointerDown(event: MouseEvent): void {
      const target = event.target as Node;
      if (
        menuTriggerRef.current?.contains(target) ||
        menuPopupRef.current?.contains(target)
      )
        return;
      setMenuRow(null);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setMenuRow(null);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuRow]);

  function openRowMenu(row: SessionRow, trigger: HTMLButtonElement): void {
    const rect = trigger.getBoundingClientRect();
    menuTriggerRef.current = trigger;
    // Opens to the RIGHT of the trigger (2026-09-10, user: "dropdown xuất
    // hiện từ bên phải nút 3 chấm") — `left: rect.right + 4`, top-aligned
    // with the trigger itself. Portaled to `document.body` (same as
    // `AccountMenu.tsx`), so opening rightward doesn't risk the sidebar's
    // own `overflow: hidden`/`overflow-y: auto` clipping it even though it
    // now extends past the sidebar's right edge into the main content area
    // — that's expected, not a bug, the same way `AccountMenu.tsx`'s own
    // popup already extends past `#sidebar-col`'s bounds in rail mode.
    setMenuPosition({ top: rect.top, left: rect.right + 4 });
    setMenuRow(row);
  }

  // Inline rename (2026-09-10, replaces the old `window.prompt` flow —
  // user: "khi ấn đổi tên biến title hiện tại thành ô input để nhập và ấn
  // enter là xong"). `startRename` only enters edit mode; the actual PATCH
  // happens in `commitRename`, called from the input's own Enter handler.
  function startRename(row: SessionRow): void {
    setRenameValue(row.title ?? "");
    setRenamingRow(row);
  }

  useEffect(() => {
    if (!renamingRow) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingRow]);

  async function commitRename(row: SessionRow): Promise<void> {
    const trimmed = renameValue.trim();
    // Empty -> cancel, not an error — matches the old `window.prompt`
    // flow's own behavior (empty input there was already a silent no-op,
    // not a validation error shown to the user).
    if (trimmed.length === 0) {
      setRenamingRow(null);
      return;
    }
    // Real check the user explicitly asked for ("nhớ có check lỗi ko quá
    // 255 kí tự") — 255 is this app's REAL `sessions.title` column width
    // (`varchar(255)`, docs/code-rules.md's DB id/title migration entry),
    // not an arbitrary guess. Checked here, client-side, BEFORE ever
    // calling the server — same order the register form's own 3 validation
    // messages already use. Keeps editing open (doesn't clear
    // `renamingRow`) so the user can just trim the text and press Enter
    // again, rather than losing what they typed.
    if (trimmed.length > TITLE_MAX_LENGTH) {
      toast.error(t("historyChat.titleTooLong"));
      return;
    }
    setRenamingRow(null);
    await runtime.authedFetch(`/sessions/${row.sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: trimmed }),
    });
    await refresh();
  }

  async function remove(row: SessionRow): Promise<void> {
    if (!window.confirm(t("historyChat.deleteConfirm"))) return;
    await runtime.authedFetch(`/sessions/${row.sessionId}`, {
      method: "DELETE",
    });
    // The just-deleted session can't be reconnected to — same "session is
    // gone" situation `App.tsx`'s own self-heal handles for a stale/403'd
    // reconnect, just triggered proactively here instead of waiting for a
    // failed reconnect attempt to discover it. `newSession()` only no-ops
    // on an already-empty unchatted session (Sidebar's "New chat" button),
    // which this never is — every row here already has `first_message_at`
    // set (`GET /sessions/mine`'s own filter), so `hasChatted` is always
    // true for whichever row happens to be the active one.
    if (row.sessionId === runtime.sessionId) runtime.newSession();
    await refresh();
  }

  return (
    <div id="fh-history-chat-list">
      {groups.length === 0 && <></>}
      {groups.map((group) => (
        <div key={group.key} className="fh-history-chat-group">
          <div className="fh-history-chat-group-label">{group.label}</div>
          {group.rows.map((row) => (
            <div
              key={row.sessionId}
              className={`fh-history-chat-row${row.sessionId === runtime.sessionId ? " active" : ""}${menuRow?.sessionId === row.sessionId ? " menu-open" : ""}`}
              onClick={() => {
                if (renamingRow?.sessionId === row.sessionId) return;
                if (row.sessionId !== runtime.sessionId)
                  runtime.switchSession(row.sessionId);
              }}
            >
              {renamingRow?.sessionId === row.sessionId ? (
                <Input
                  ref={renameInputRef}
                  type="text"
                  className="fh-history-chat-row-rename-input"
                  value={renameValue}
                  // No native `maxLength` here on purpose — it would
                  // silently swallow keystrokes/paste past 255 chars
                  // instead of letting the user hit the real, visible
                  // error `commitRename` shows (the check the user
                  // explicitly asked for).
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    // Real bug fixed 2026-09-10 (user: "vẫn ko đổi tên
                    // thành công" — found via services/gateway's own log:
                    // zero PATCH/rename_ok entries despite normal WS
                    // activity from the real account, meaning the request
                    // never even left the browser). Vietnamese input
                    // commonly goes through an IME (Unikey/VNI/...), which
                    // also uses Enter to CONFIRM a composition candidate —
                    // browsers still dispatch a `keydown` with `key ===
                    // 'Enter'` during that, so this handler was firing
                    // (and calling `preventDefault()`, interrupting the
                    // IME) before the composed Vietnamese text had even
                    // landed in `renameValue` yet, silently committing a
                    // stale/empty value — hitting `commitRename`'s own
                    // empty-string no-op path, with no error and no
                    // network call, exactly matching what was reported.
                    // `event.nativeEvent.isComposing` is the standard,
                    // cross-browser way to tell "IME still composing"
                    // apart from a real, finished Enter press.
                    if (event.key === "Enter") {
                      if (event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      void commitRename(row);
                    } else if (event.key === "Escape") {
                      setRenamingRow(null);
                    }
                  }}
                  onBlur={() => setRenamingRow(null)}
                />
              ) : (
                <span className="fh-history-chat-row-title">
                  {rowLabel(row, t)}
                </span>
              )}
              {renamingRow?.sessionId !== row.sessionId && (
                <IconButton
                  size="sm"
                  variant="plain"
                  className="fh-history-chat-row-menu-trigger"
                  title={t("historyChat.rowActions")}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (menuRow?.sessionId === row.sessionId) setMenuRow(null);
                    else openRowMenu(row, event.currentTarget);
                  }}
                >
                  <MoreIcon size={14} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      ))}
      {menuRow &&
        menuPosition &&
        createPortal(
          <div
            ref={menuPopupRef}
            className="fh-history-chat-row-menu-popup"
            style={{ top: menuPosition.top, left: menuPosition.left }}
          >
            <MenuItem
              variant="popup"
              onClick={() => {
                const row = menuRow;
                setMenuRow(null);
                startRename(row);
              }}
            >
              <PencilIcon size={15} />
              {t("historyChat.rename")}
            </MenuItem>
            <MenuItem
              variant="popup"
              className="fh-menu-item-danger"
              onClick={() => {
                const row = menuRow;
                setMenuRow(null);
                void remove(row);
              }}
            >
              <TrashIcon size={15} />
              {t("historyChat.delete")}
            </MenuItem>
          </div>,
          document.body,
        )}
    </div>
  );
}
