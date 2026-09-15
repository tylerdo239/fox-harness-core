// Chat log + composer + command palette. Was `packages/client-ui-conversation`,
// a separately-loaded UI plugin bundle (Phase 4-12); now just a component in
// the one shared app (2026-09-08 follow-up — see apps/web/README.md for why).
// Behavior is unchanged from the pre-2026-09-08 version — only the delivery
// mechanism (separate bundle + `window.__FOX_HARNESS__`) is gone, replaced
// by `useRuntime()` (a normal React Context, apps/web/src/runtime.ts).
//
// Dropped in this move: `registerNodeRenderer`/`getNodeRenderer` — a
// registry that let a THIRD-PARTY UI plugin contribute a custom
// content-block renderer. It had zero real registered consumers for its
// entire existence (docs/code-rules.md's Phase 9 entry already noted this),
// and the whole point of a cross-bundle extension registry is moot now that
// there's only one bundle — removed as genuinely dead code, not simplified
// away from something that worked.
//
// Casual redesign (2026-09-10, user: "hide hết và làm UI UX lại cho casual
// như các platform ai agent" — follow-up after asking about 3 specific
// things that read as "technical harness", not "chat app": the `turn {n}`
// divider, the `steer` checkbox, and raw `→ tool(args)`/`← result` cards).
// 3 real changes, not a repaint:
// 1. `turn/start` no longer pushes a visible divider at all (see that
//    case's own comment) — real consumer platforms show no turn-boundary
//    chrome.
// 2. The `steer` checkbox is gone from the composer — every send is a
//    real `followup` now. `steer` stays a real wire type (`wire.ts`, still
//    a real dsh session capability) — only the UI's ability to toggle it
//    is removed, not the underlying protocol support.
// 3. `tool/call`/`tool/result` no longer render as 2 separate always-
//    expanded monospace cards — 1 real collapsible pill per tool call
//    (`ToolPill` below), collapsed by default, matching claude.ai/
//    ChatGPT's own "used a tool" affordance: transparent that the agent
//    did something, without dumping raw JSON into the chat by default.
//
// Same-day follow-up (user: "check vẫn có dòng tiếng anh reasoning hide
// đi và ui đoạn chat AI trả lời ko cần bọc container như 1 chat message
// full đi") — 2 more real changes:
// 4. (SUPERSEDED below — reasoning removed entirely, not just collapsed.)
// 5. An assistant reply no longer renders inside a `.bubble` (rounded/
//    colored/shadowed container) — real claude.ai/ChatGPT/Gemini/
//    chat.deepseek.com all render the USER's message as a bubble but the
//    ASSISTANT's reply as plain, left-aligned, full-width flowing text
//    with no container at all. `.bubble`/`.bubble-user` stay exactly as
//    they were (still real, still used) — only the assistant side drops
//    the bubble wrapper, in favor of `.assistant-text`.
//
// Same-day follow-up #3 (user: "bỏ luôn phần reasoning luôn đi ko cần
// nữa, bỏ cả /new và /rename này luôn và khi input focus ko cần outline
// cam cũng như border input là ko cần thiết cho input chat") — 3 more:
// 6. Reasoning removed ENTIRELY (not collapsed anymore, item 4 above is
//    gone) — no `ReasoningToggle`, no `reasoning` field on `LogEntry`/
//    `LiveBubble`, `reasoning-delta` chunks aren't even accumulated
//    anymore. The collapsed-toggle version from the previous follow-up
//    was a real, deliberate design choice at the time (matching the tool
//    pill's own "transparent but out of the way" treatment) — the user
//    tried it and decided they don't want it at all, not even collapsed.
// 7. The `/`-triggered command palette (`/new`, `/rename`) is gone —
//    both actions already have real dedicated UI elsewhere (Sidebar's
//    "New chat" button; HistoryChat's own row rename, §75) that this
//    duplicated. `COMMANDS`/`Command`/the dropdown are all removed, not
//    hidden — genuinely dead now that nothing triggers them.
// 8. `#text-input` (this composer's own text field) drops its border
//    entirely, in every state including focus (no more accent-colored
//    focus border) — `input[type="text"]`'s shared base rule still
//    applies to every OTHER text input in the app (login, search,
//    HistoryChat's rename field, ...), only this one opts out.

import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { toast } from "sonner";

import {
  BrandIcon,
  ChevronDownIcon,
  SearchIcon,
  ToolIcon,
} from "../../../icons.tsx";
import { translateErrorCode, useLocale } from "../../../i18n/locale.tsx";
import type { Locale, TranslationKey } from "../../../i18n/translations.ts";
import { useRuntime } from "../../../runtime.ts";
import type {
  ContentBlock,
  ServerToClient,
  StreamChunk,
  TextBlock,
  ToolResultBlock,
  WireMessage,
} from "../../../wire.ts";
import { Button } from "../../primitives/Button.tsx";
import {
  createCustomSkill,
  refreshSkillMenu,
  SkillApiError,
} from "../skills/skillsApi.ts";
import { Markdown } from "./Markdown.tsx";
import { SkillMenu, slashQuery, useSkillMenu } from "./SkillMenu.tsx";
import { WorkspacePanel } from "./WorkspacePanel.tsx";

// docs/skill-transfer-plan.md, giai đoạn 3: the `create_skill` tool only
// validates inside the worker, which never knows who the user is. The browser,
// already signed in as that user, does the actual save.
const CREATE_SKILL_TOOL = "create_skill";

// Real upstream tool name (`@deepseek-ai/dsh-tool-web`, confirmed against
// its installed `lib/index.js` — not guessed), Serper plugged in as its
// search provider (packages/tool/serper-web-search). 2026-09-15: every call
// merges into a `SearchSourcesPill` instead of a generic `ToolPill` — see
// `LogEntry`'s `"search"` variant.
const WEB_SEARCH_TOOL = "web_search";

// 2026-09-15 (user: "Đừng show UI đã dùng skill hay bash gì") — real tool
// names confirmed against installed `.js` (not guessed): `@deepseek-ai/
// dsh-tool-skill` registers `"skill"` (loading a skill's content into
// context when `/tên-skill` fires or the model calls it directly),
// `@deepseek-ai/dsh-tool-bash`/`dsh-tool-bash-persistent` both register
// `"bash"`. Both are internal/mechanical — a "Đã dùng skill"/"Đã dùng bash"
// pill tells the user nothing they'd act on, unlike `web_search`'s real
// sources. `tool/call` below skips pushing an entry at all for these names;
// their later `tool/result` naturally no-ops in `updateEntry` (nothing
// matches `tool-${callId}`), same as any id that was never pushed.
const HIDDEN_TOOLS = new Set(["skill", "bash"]);

// Real shape of `tool/result`'s `event.data.meta` for a `web_search` call —
// `dsh-tools`' own `presentationMeta()` output, confirmed against its
// installed source while researching this feature. Narrowed here rather
// than trusted blindly: `meta` is `unknown` on the wire (`wire.ts`'s
// `SessionEvent.data` is deliberately untyped), and a malformed/absent
// shape must fall back to "0 sources found," never throw.
function parseWebSearchMeta(
  meta: unknown,
): { sources: WebSource[]; truncated: boolean; answer?: string } | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const record = meta as Record<string, unknown>;
  if (!Array.isArray(record.sources)) return undefined;
  const sources: WebSource[] = [];
  for (const raw of record.sources) {
    if (typeof raw !== "object" || raw === null) continue;
    const source = raw as Record<string, unknown>;
    if (typeof source.url !== "string") continue;
    sources.push({
      url: source.url,
      title: typeof source.title === "string" ? source.title : undefined,
      snippet: typeof source.snippet === "string" ? source.snippet : undefined,
      publishedAt:
        typeof source.publishedAt === "string" ? source.publishedAt : undefined,
    });
  }
  return {
    sources,
    truncated: record.truncated === true,
    answer: typeof record.answer === "string" ? record.answer : undefined,
  };
}

// ---- Declarative log state.

// docs/code-rules.md convention this file already follows: real fields,
// confirmed against installed .d.ts, not guessed.
interface WebSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

type LogEntry =
  | { kind: "notice"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      turn: number;
      name: string;
      args: string;
      status: "running" | "done" | "error";
      resultText: string | null;
    }
  // 2026-09-15 (user: "UI dùng tool đang ghi là dùng web_search... ghi là
  // Đang tra cứu... show chung các kết quả của mọi lần gọi tool search vào
  // 1") — every `web_search` tool call in the SAME turn merges into ONE of
  // these instead of a separate `ToolPill` per call. `pendingCalls` counts
  // calls made but not yet resolved (can be >1 — the model can have
  // several `web_search` calls in flight, or make more after this turn's
  // first one already resolved); the pill reads "running" while it's >0.
  | {
      kind: "search";
      id: string;
      turn: number;
      pendingCalls: number;
      hasError: boolean;
      sources: WebSource[];
      truncated: boolean;
      answer?: string;
    }
  | { kind: "bubble"; id: string; role: "user" | "assistant"; text: string };

interface LiveBubble {
  text: string;
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

function contentToText(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Real gap found and fixed (2026-09-11, user: "ko có lịch sử tool search
// show trên UI chat khi tìm kiếm xong gồm link ntn") — this app has never
// rendered a link anywhere: assistant replies and tool-pill result text are
// both plain JSX text interpolation (React auto-escapes, no HTML/markdown
// parsing at all). The system prompt explicitly tells the model to "Cite
// result URLs as markdown links" (packages/tool/duckduckgo-web-search's own
// `tool:duckduckgo_web_search` section), and duckduckgo_web_search's own
// rendered tool-result text is literally `${title}\n   ${url}\n   ${snippet}`
// per result — both only ever showed up as inert text, never a clickable
// link, which is exactly what reads as "no search history" even though the
// data was there the whole time.
//
// Real markdown rendering added 2026-09-15 (`Markdown.tsx`) for the 2 spots
// that show actual model output (a finished assistant bubble, the live
// streaming bubble) — this `linkify()` stays only for `tool-pill-result`
// below, which never needed more than link detection.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')\]]+)/g;

function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(LINK_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index));
    const [full, mdLabel, mdUrl, bareUrl] = match;
    const url = mdUrl ?? bareUrl;
    nodes.push(
      <a
        key={key++}
        className="fh-link"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={hostnameOf(url) ?? url}
      >
        {mdLabel ?? bareUrl}
      </a>,
    );
    lastIndex = index + full.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

// Real bug fixed 2026-09-11 (user: "có rất nhiều assistant text dưới 1
// tool-pill mà ko có chữ") — confirmed against a real decompressed session
// log: every step that makes a tool call has dsh's own `BlockAssembler`
// split off a text block that's JUST `"\n\n"` right before the `tool-call`
// block (real captured example: `[{type:"reasoning",...},
// {type:"text",text:"\n\n"}, {type:"tool-call",...}]`). `"\n\n"` is a
// non-empty string — truthy in JS — so the old plain `if (!text) return`
// guard let it straight through, producing a real, persisted, empty-looking
// bubble every single time the model calls a tool. `.trim()` before the
// emptiness check (and on the stored value, so a message that DOES have
// real content doesn't render with stray leading/trailing blank lines
// either — the same real log shows genuine replies prefixed with their own
// leading `"\n\n"`) is the correct fix — whitespace-only is exactly
// "nothing to show," same reasoning already applied to the tool-pill fixes
// this session.
function buildBubbleEntry(
  id: string,
  role: "user" | "assistant",
  content: ContentBlock[],
): LogEntry | undefined {
  const text = contentToText(content).trim();
  if (!text) return undefined;
  return { kind: "bubble", id, role, text };
}

// Collapsed by default — `expanded`/`onToggle` are lifted to Conversation's
// own state (`expandedDetails`, a `Set<id>` — was shared with a reasoning
// toggle too until that was removed entirely, 2026-09-10; kept as a
// generic `Set` rather than reverting to a tool-pill-only name in case
// something else needs the same "collapsed detail" pattern later) rather
// than living on the `LogEntry` itself, since expand/collapse is pure
// local UI state, not server-log data (same separation `liveBubbles`
// already keeps from `entries`).
function ToolPill({
  entry,
  expanded,
  onToggle,
  t,
}: {
  entry: Extract<LogEntry, { kind: "tool" }>;
  expanded: boolean;
  onToggle: () => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
}) {
  const label =
    entry.status === "running"
      ? t("conversation.toolRunning", { name: entry.name })
      : entry.status === "error"
        ? t("conversation.toolFailed", { name: entry.name })
        : t("conversation.toolUsed", { name: entry.name });
  return (
    <div
      className={`tool-pill${entry.status === "error" ? " tool-pill-error" : ""}${expanded ? " expanded" : ""}`}
    >
      <button type="button" className="tool-pill-header" onClick={onToggle}>
        <ToolIcon size={13} />
        <span>{label}</span>
        <ChevronDownIcon size={13} className="tool-pill-chevron" />
      </button>
      {expanded && (
        <div className="tool-pill-detail">
          <div className="tool-pill-args">{entry.args}</div>
          {entry.resultText && (
            <div className="tool-pill-result">{linkify(entry.resultText)}</div>
          )}
        </div>
      )}
    </div>
  );
}

// `undefined` on a malformed URL — callers fall back to the raw string.
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

// Fallback label when a source has no `title` — bare hostname reads better
// than a raw URL in a link's visible text (matches the real dsh reference
// UI's own `sourceLabel()`/`Dd()` behavior found while researching this).
function sourceLabel(source: WebSource): string {
  return source.title || hostnameOf(source.url) || source.url;
}

// 2026-09-15 (user: "đang có issue khi lang là VN mà các ngày hay time
// trong search chưa đc parse") — Serper mirrors Google's own raw SERP date
// string verbatim: sometimes absolute ("Jul 25, 2025"), sometimes relative
// ("7 months ago", "1 year ago") — always English, regardless of this app's
// own language setting. Real pasted example that surfaced the bug: a
// results list mixing both forms across different sources in the same
// response. Parsed and reformatted per-locale here; an unrecognized shape
// (Serper's date field isn't a documented/stable format) falls back to the
// raw string as-is rather than showing nothing.
const RELATIVE_TIME_RE = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
const VI_TIME_UNIT: Record<string, string> = {
  second: "giây",
  minute: "phút",
  hour: "giờ",
  day: "ngày",
  week: "tuần",
  month: "tháng",
  year: "năm",
};

function formatPublishedAt(raw: string, locale: Locale): string {
  const relative = RELATIVE_TIME_RE.exec(raw.trim());
  if (relative) {
    const [, amount, unit] = relative;
    if (locale === "vi") return `${amount} ${VI_TIME_UNIT[unit.toLowerCase()]} trước`;
    return raw;
  }
  const parsedMs = Date.parse(raw);
  if (!Number.isNaN(parsedMs)) {
    return new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date(parsedMs));
  }
  return raw;
}

// 2026-09-15: replaces `ToolPill` for every `web_search` call — see
// `LogEntry`'s `"search"` variant comment for why these merge across calls
// instead of one pill each. Collapsed by default, same
// `expandedDetails`/`toggleDetailExpanded` state `ToolPill` uses.
function SearchSourcesPill({
  entry,
  expanded,
  onToggle,
  t,
  locale,
}: {
  entry: Extract<LogEntry, { kind: "search" }>;
  expanded: boolean;
  onToggle: () => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
  locale: Locale;
}) {
  const isError = entry.hasError && entry.sources.length === 0;
  const label =
    entry.pendingCalls > 0
      ? t("conversation.searching")
      : isError
        ? t("conversation.searchFailed")
        : entry.sources.length === 0
          ? t("conversation.searchEmpty")
          : t("conversation.searched", { n: String(entry.sources.length) });
  return (
    <div
      className={`tool-pill search-pill${isError ? " tool-pill-error" : ""}${expanded ? " expanded" : ""}`}
    >
      <button type="button" className="tool-pill-header" onClick={onToggle}>
        <SearchIcon size={13} />
        <span>{label}</span>
        <ChevronDownIcon size={13} className="tool-pill-chevron" />
      </button>
      {expanded && entry.sources.length > 0 && (
        <div className="tool-pill-detail search-pill-detail">
          <ol className="search-pill-list">
            {entry.sources.map((source, index) => (
              <li key={`${source.url}-${index}`}>
                <a
                  className="fh-link search-pill-source-link"
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={hostnameOf(source.url) ?? source.url}
                >
                  {sourceLabel(source)}
                </a>
                {source.snippet && (
                  <div className="search-pill-snippet">{source.snippet}</div>
                )}
                {source.publishedAt && (
                  <div className="search-pill-published">
                    {formatPublishedAt(source.publishedAt, locale)}
                  </div>
                )}
              </li>
            ))}
          </ol>
          {entry.truncated && (
            <div className="search-pill-truncated">
              {t("conversation.searchTruncated")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LogEntryView({
  entry,
  isExpanded,
  onToggleExpanded,
  t,
  locale,
}: {
  entry: LogEntry;
  isExpanded: (id: string) => boolean;
  onToggleExpanded: (id: string) => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
  locale: Locale;
}) {
  switch (entry.kind) {
    case "notice":
      return <div className="notice">{entry.text}</div>;
    case "tool":
      return (
        <ToolPill
          entry={entry}
          expanded={isExpanded(entry.id)}
          onToggle={() => onToggleExpanded(entry.id)}
          t={t}
        />
      );
    case "search":
      return (
        <SearchSourcesPill
          entry={entry}
          expanded={isExpanded(entry.id)}
          onToggle={() => onToggleExpanded(entry.id)}
          t={t}
          locale={locale}
        />
      );
    case "bubble":
      if (entry.role === "user") {
        return (
          <div className="bubble bubble-user">
            <span>{entry.text}</span>
          </div>
        );
      }
      return (
        <div className="assistant-text">
          {entry.text && (
            <div className="assistant-text-body">
              <Markdown text={entry.text} />
            </div>
          )}
        </div>
      );
  }
}

export function Conversation() {
  const runtime = useRuntime();
  const { t, locale } = useLocale();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [liveBubbles, setLiveBubbles] = useState<Map<string, LiveBubble>>(
    new Map(),
  );
  // 2026-09-15: `text-delta` chunks used to call `setLiveBubbles` (and
  // trigger a full re-render + markdown re-parse) once per network chunk —
  // fine for plain text, but `Markdown.tsx`'s `rehype-highlight` pass makes
  // that cost real once code blocks are involved. Deltas accumulate here
  // between animation frames instead; `flushLiveBubbleDeltas` applies all of
  // them in one `setLiveBubbles` call per frame, capping the expensive
  // parse+highlight work at the screen's own refresh rate regardless of how
  // fast the network delivers chunks (Markdown.tsx's own header comment has
  // the full reasoning for why this, not component memoization, is where
  // the fix belongs).
  const pendingDeltasRef = useRef<Map<string, string>>(new Map());
  const flushScheduledRef = useRef(false);
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(
    new Set(),
  );
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skillItems = useSkillMenu(runtime);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissedFor, setMenuDismissedFor] = useState<string | null>(null);
  // create_skill arguments by callId, held until that call's result arrives.
  const skillCallArgsRef = useRef(new Map<string, string>());
  // Which in-flight `callId`s are `web_search` calls (2026-09-15) — checked
  // (and removed) at `tool/result` time to route that result into a merged
  // `SearchSourcesPill` instead of a generic `ToolPill`. A `Set`, not a
  // `Map` to a turn number, because the real `tool/result` event already
  // carries `turn` itself — this only needs to answer "was this call a
  // search."
  const searchCallIdsRef = useRef(new Set<string>());
  // `handleEvent`/`handleFrame` below are only ever subscribed ONCE, at
  // mount (see that effect's own comment — a deliberate, load-bearing
  // design, not something i18n should break). A plain closure over `t`
  // would freeze every tool-pill/notice string at whatever language was
  // active at mount, forever, even after a later language switch — a ref
  // sidesteps that without touching the mount-once subscription at all.
  const tRef = useRef(t);
  tRef.current = t;

  function pushEntry(entry: LogEntry | undefined): void {
    if (!entry) return;
    setEntries((prev) => [...prev, entry]);
  }

  // Applies every delta accumulated since the last animation frame in one
  // `setLiveBubbles` call — see the `pendingDeltasRef` comment above for why.
  function flushLiveBubbleDeltas(): void {
    flushScheduledRef.current = false;
    const pending = pendingDeltasRef.current;
    if (pending.size === 0) return;
    pendingDeltasRef.current = new Map();
    setLiveBubbles((prev) => {
      const next = new Map(prev);
      for (const [pendingKey, delta] of pending) {
        const existing = next.get(pendingKey) ?? { text: "" };
        next.set(pendingKey, { ...existing, text: existing.text + delta });
      }
      return next;
    });
  }

  function scheduleLiveBubbleFlush(): void {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    requestAnimationFrame(flushLiveBubbleDeltas);
  }

  // Updates an already-pushed entry in place (by id) — used when a later
  // event (`tool/result`) completes something an earlier event
  // (`tool/call`) already rendered, instead of pushing a 2nd separate
  // entry the way the old always-expanded 2-card layout did.
  function updateEntry(
    id: string,
    updater: (entry: LogEntry) => LogEntry,
  ): void {
    setEntries((prev) =>
      prev.map((entry) => (entry.id === id ? updater(entry) : entry)),
    );
  }

  // Create-or-merge for the per-turn `"search"` entry (2026-09-15) — reads
  // `prev` from the functional `setEntries` form, never the outer
  // closure's `entries`, same "handleFrame/handleEvent never read state
  // directly" rule `updateEntry`/`pushEntry` already follow (see the
  // mount-once WS-subscription effect's own comment below for why that
  // rule exists). `merge` only ever runs against an entry that already
  // exists (a fresh one is exactly `create()`, no merge needed the first
  // time), so it's never called with anything but a `"search"` entry.
  function upsertSearchEntry(
    turn: number,
    create: () => Extract<LogEntry, { kind: "search" }>,
    merge: (
      entry: Extract<LogEntry, { kind: "search" }>,
    ) => Extract<LogEntry, { kind: "search" }>,
  ): void {
    const id = `search-${turn}`;
    setEntries((prev) => {
      const index = prev.findIndex((entry) => entry.id === id);
      if (index === -1) return [...prev, create()];
      const next = [...prev];
      next[index] = merge(next[index] as Extract<LogEntry, { kind: "search" }>);
      return next;
    });
  }

  function toggleDetailExpanded(id: string): void {
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // `live` = arrived as its own `event` frame, not replayed inside a
  // `snapshot`. Only a live create_skill result saves a skill, so reopening
  // an old chat never saves the same skill again.
  function handleEvent(
    event: { type: string; seq: number; data: unknown },
    live: boolean,
  ): void {
    switch (event.type) {
      case "turn/start":
        // Deliberately not rendered (2026-09-10, user: "hide hết ... làm
        // UI UX lại cho casual như các platform ai agent") — used to push
        // a visible "lượt {n}" divider for every turn boundary, including
        // the very first (nothing to visually divide from yet). Real
        // consumer AI chat platforms show no turn/message-count chrome at
        // all; this app doesn't need one either to function, only to look
        // like an agent-harness debug tool. The boundary itself is still
        // real and still tracked server-side (`data.turn` on every other
        // event this session emits) — only the UI marker is gone.
        break;
      case "turn/end": {
        const data = event.data as {
          turn: number;
          reason: { kind: string; error?: { code: string; message: string } };
        };
        if (data.reason.kind === "error" && data.reason.error) {
          pushEntry({
            kind: "notice",
            id: `evt-${event.seq}`,
            text: tRef.current("conversation.modelError", {
              code: data.reason.error.code,
              message: data.reason.error.message,
            }),
          });
        } else if (data.reason.kind !== "completed") {
          pushEntry({
            kind: "notice",
            id: `evt-${event.seq}`,
            text: tRef.current("conversation.turnEnded", {
              n: String(data.turn),
              reason: data.reason.kind,
            }),
          });
        }
        // Real bug fixed 2026-09-11 (user: "box contain tool-pill vẫn còn
        // mà ko có dữ liệu ... bị shrink") — a `tool/call` whose turn ended
        // without a matching `tool/result` ever arriving (container
        // hibernated/crashed mid-call — docs/core-overview.md's own known
        // gap: idle sweep doesn't check turn status before hibernating)
        // used to stay "running" forever: a tiny pill with no result
        // content and a spinner that never resolves. This turn has now
        // definitively ended per the server's own event, so any of ITS
        // tool entries still "running" never will complete — reclassify
        // instead of leaving them stuck. Scoped to `data.turn` specifically
        // (not "every running entry") so a DIFFERENT turn's genuinely
        // in-flight tool call is never touched.
        setEntries((prev) =>
          prev.map((entry) => {
            if (
              entry.kind === "tool" &&
              entry.turn === data.turn &&
              entry.status === "running"
            ) {
              return {
                ...entry,
                status: "error",
                resultText: tRef.current("conversation.toolInterrupted"),
              };
            }
            // Same reclassification, applied to a `web_search` call this
            // turn ended without ever resolving — otherwise its
            // `SearchSourcesPill` would read "Đang tra cứu…" forever.
            if (
              entry.kind === "search" &&
              entry.turn === data.turn &&
              entry.pendingCalls > 0
            ) {
              return { ...entry, pendingCalls: 0, hasError: true };
            }
            return entry;
          }),
        );
        break;
      }
      case "user/message": {
        const message = event.data as WireMessage & { source?: { kind: string } };
        // Only what the user typed. dsh also appends context for the model as
        // user messages — the skill catalog (`skill-catalog`) and a `/name`
        // skill body (`skill-invocation`) — which don't belong in the chat.
        if (message.source && message.source.kind !== "user") break;
        pushEntry(
          buildBubbleEntry(`evt-${event.seq}`, "user", message.content),
        );
        break;
      }
      case "assistant/chunk": {
        const data = event.data as {
          turn: number;
          step: number;
          chunk: StreamChunk;
        };
        const key = stepKey(data.turn, data.step);
        const chunk = data.chunk;
        // Deltas extracted to a plain-string const BEFORE the setState
        // updater below — TypeScript does not carry a discriminated-union
        // narrowing into a nested closure (docs/code-rules.md's repeated
        // "closure narrowing" bug class); a plain `string` needs no
        // narrowing to begin with. `reasoning-delta` chunks are no longer
        // handled at all (2026-09-10, removed entirely, not just hidden —
        // see this file's own header comment) — they fall through to the
        // implicit no-op below, same as any other chunk type this app
        // doesn't render.
        if (chunk.type === "text-delta") {
          const textDelta = chunk.text;
          const pending = pendingDeltasRef.current;
          pending.set(key, (pending.get(key) ?? "") + textDelta);
          scheduleLiveBubbleFlush();
        }
        break;
      }
      case "assistant/message": {
        const data = event.data as {
          turn: number;
          step: number;
          message: WireMessage;
        };
        const key = stepKey(data.turn, data.step);
        // A delta for this exact key can still be sitting unflushed in
        // `pendingDeltasRef` (the next animation frame hasn't run yet) —
        // drop it now, or the scheduled flush would resurrect this bubble
        // with a stray trailing fragment right after it's already been
        // pushed to `entries` as finished below.
        pendingDeltasRef.current.delete(key);
        setLiveBubbles((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        // Tool-call blocks inside `message.content` render separately via
        // the dedicated 'tool/call' event that follows (agent.ts appends it
        // right after) — skip here to avoid a duplicate.
        const withoutToolCalls = data.message.content.filter(
          (block) => block.type !== "tool-call",
        );
        // Reuses `key` (`stepKey(turn, step)`, same as the live bubble
        // above) as this entry's id rather than `evt-${event.seq}` — a
        // real fix from when a since-removed reasoning toggle needed this
        // id stable across the live-to-finished transition (see
        // docs/code-rules.md §80); kept even after that toggle's removal
        // since it's still a perfectly good, real, unique id — no reason
        // to revert to a different one for its own sake.
        pushEntry(buildBubbleEntry(key, "assistant", withoutToolCalls));
        break;
      }
      case "tool/call": {
        // `callId` (real field, dsh-session's own `SessionEventMap['tool/call']`
        // — confirmed against the installed .d.ts, not guessed) is what
        // correlates this call with its LATER `tool/result` — the id this
        // entry is pushed under, so `tool/result` below can update it in
        // place instead of pushing a 2nd separate entry.
        const data = event.data as {
          turn: number;
          callId: string;
          name: string;
          arguments: string;
        };
        if (HIDDEN_TOOLS.has(data.name)) break;
        if (data.name === WEB_SEARCH_TOOL) {
          searchCallIdsRef.current.add(data.callId);
          upsertSearchEntry(
            data.turn,
            () => ({
              kind: "search",
              id: `search-${data.turn}`,
              turn: data.turn,
              pendingCalls: 1,
              hasError: false,
              sources: [],
              truncated: false,
            }),
            (entry) => ({ ...entry, pendingCalls: entry.pendingCalls + 1 }),
          );
          break;
        }
        let pretty = data.arguments;
        try {
          pretty = JSON.stringify(JSON.parse(data.arguments), null, 2);
        } catch {
          // not valid JSON (or empty) — show raw
        }
        pushEntry({
          kind: "tool",
          id: `tool-${data.callId}`,
          turn: data.turn,
          name: data.name,
          args: pretty,
          status: "running",
          resultText: null,
        });
        if (data.name === CREATE_SKILL_TOOL) {
          skillCallArgsRef.current.set(data.callId, data.arguments);
        }
        break;
      }
      case "tool/result": {
        const data = event.data as {
          turn: number;
          message: { content: [ToolResultBlock] };
          error?: { message?: string; name: string };
          meta?: unknown;
        };
        const block = data.message.content[0];
        const callId = block?.toolCallId;
        const isError = !!(data.error || block?.isError);
        // `searchCallIdsRef.delete()` both checks AND consumes membership —
        // a `web_search` result is routed here exactly once, same as any
        // other tool's `tool/result`.
        if (callId && searchCallIdsRef.current.delete(callId)) {
          const parsed = isError ? undefined : parseWebSearchMeta(data.meta);
          upsertSearchEntry(
            data.turn,
            () => ({
              kind: "search",
              id: `search-${data.turn}`,
              turn: data.turn,
              pendingCalls: 0,
              hasError: isError || !parsed,
              sources: parsed?.sources ?? [],
              truncated: parsed?.truncated ?? false,
              answer: parsed?.answer,
            }),
            (entry) => {
              const seen = new Set(entry.sources.map((source) => source.url));
              const merged = [...entry.sources];
              for (const source of parsed?.sources ?? []) {
                if (seen.has(source.url)) continue;
                seen.add(source.url);
                merged.push(source);
              }
              return {
                ...entry,
                pendingCalls: Math.max(0, entry.pendingCalls - 1),
                hasError: entry.hasError || isError || !parsed,
                sources: merged,
                truncated: entry.truncated || (parsed?.truncated ?? false),
                answer: entry.answer ?? parsed?.answer,
              };
            },
          );
          break;
        }
        const blockText = block ? contentToText(block.content) : "";
        const resultText = isError
          ? (data.error?.name ?? blockText)
          : truncate(blockText, 500);
        // `block?.toolCallId` (real field, `ToolResultBlock` — same .d.ts
        // as above) is the SAME id `tool/call` above used to push this
        // entry, so this always finds and completes the right pill even
        // with several tool calls in flight in the same turn.
        updateEntry(`tool-${callId}`, (entry) =>
          entry.kind === "tool"
            ? { ...entry, status: isError ? "error" : "done", resultText }
            : entry,
        );
        const skillArgs = callId ? skillCallArgsRef.current.get(callId) : undefined;
        if (callId && skillArgs !== undefined) {
          skillCallArgsRef.current.delete(callId);
          if (live && !isError) void saveSkillFromChat(skillArgs);
        }
        break;
      }
      default:
        // Forward-compatible: unrecognized event types (todo/write,
        // request/header, session/end-seed, …) are silently skipped,
        // matching the real SessionEvent contract's own "switch and fall
        // through unknowns" guidance (dsh-session's types.d.ts).
        break;
    }
  }

  function handleFrame(frame: ServerToClient): void {
    switch (frame.type) {
      case "snapshot":
        setEntries([]);
        setLiveBubbles(new Map());
        pendingDeltasRef.current.clear();
        for (const event of frame.events) handleEvent(event, false);
        break;
      case "event":
        handleEvent(frame.event, true);
        break;
      case "error":
        pushEntry({
          kind: "notice",
          id: `err-${crypto.randomUUID()}`,
          text: frame.message,
        });
        break;
      case "session":
        // App.tsx owns displaying the session id — nothing to render here.
        break;
    }
  }

  // No dependency on `entries`/`liveBubbles` on purpose — handleFrame/
  // handleEvent only ever update state through the functional setState
  // form, never read the outer closure's state directly, so subscribing
  // once on mount is correct and never goes stale.
  useEffect(() => {
    const unsubscribe = runtime.onFrame(handleFrame);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, liveBubbles]);

  // Auto-grow the composer with content (`text` dependency covers both
  // typing AND the `setText('')` reset after send, so it collapses back
  // down too) — reset to 'auto' first or `scrollHeight` would only ever
  // grow, never shrink back when text is deleted. `#text-input`'s CSS
  // `max-height: 15em` (~10 lines) does the actual capping; this only ever
  // grows the inline height to fit content, so past 10 lines the browser
  // clips it and shows the scrollbar on its own — no line-counting here.
  //
  // Real bug fixed (2026-09-11, user: "lúc mới vô khi ko có input thì hiện
  // max 10 dòng nhấn chữ lại nhảy về 3"): an EMPTY box used to still get an
  // explicit inline `px` height written here (`scrollHeight` of empty
  // content). That inline height only ever tracked the LAST context this
  // effect ran in — switching between the centered new-chat composer (CSS
  // `min-height: 4.5em`, 3 lines) and the docked one (`min-height: 1.5em`)
  // changes which CSS floor should apply, but doesn't itself change `text`,
  // so this effect never reruns to resync, leaving a stale explicit height
  // (in the reported case, effectively pinned near the `max-height` ceiling)
  // until a keystroke finally changed `text` and forced a real recompute.
  // Fix: when there's no content at all, clear the inline height instead of
  // setting one — an empty box always falls back to whichever CSS
  // `min-height` is currently active, so it can never carry a stale value
  // across a context switch.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!text) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  async function saveSkillFromChat(argsJson: string): Promise<void> {
    let args: { name?: unknown; description?: unknown; content?: unknown };
    try {
      args = JSON.parse(argsJson);
    } catch {
      return;
    }
    const name = String(args.name ?? "");
    try {
      await createCustomSkill(runtime, {
        name,
        description: String(args.description ?? ""),
        content: String(args.content ?? ""),
      });
      toast.success(tRef.current("skills.createdFromChat", { name }));
      void refreshSkillMenu(runtime);
    } catch (error) {
      // The tool already rejected real name clashes inside the worker, so a
      // skill_exists here means another open tab of this chat saved it first.
      if (error instanceof SkillApiError && error.code === "skill_exists") return;
      toast.error(
        error instanceof SkillApiError
          ? translateErrorCode(tRef.current, error.code, error.message)
          : String(error),
      );
    }
  }

  const slash = slashQuery(text);
  const menuItems =
    slash === undefined || menuDismissedFor === text
      ? []
      : skillItems.filter((item) => item.name.includes(slash));
  const activeMenuIndex = Math.min(menuIndex, Math.max(menuItems.length - 1, 0));

  function chooseSkill(name: string): void {
    setText(`/${name} `);
    setMenuIndex(0);
    textareaRef.current?.focus();
  }

  function sendMessage(): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    runtime.send({ type: "followup", text: trimmed });
    setText("");
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    sendMessage();
  }

  // A `<textarea>` (unlike the single-line `<input>` this replaced) never
  // submits its form on Enter by itself — Enter just inserts a newline.
  // Matches real chat platforms (chat.deepseek.com/ChatGPT/claude.ai):
  // Enter sends, Shift+Enter inserts a newline. `isComposing` guard: some
  // IMEs (incl. Vietnamese Telex in some browsers) fire a composition
  // session around Enter to confirm a candidate — without this guard that
  // confirm keystroke would send the message mid-composition instead of
  // just finishing the word.
  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (menuItems.length > 0 && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMenuIndex((activeMenuIndex + step + menuItems.length) % menuItems.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseSkill(menuItems[activeMenuIndex].name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDismissedFor(text);
        return;
      }
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    sendMessage();
  }

  // Real chat.deepseek.com screenshot (2026-09-08) showed a rich centered
  // "welcome" screen before any message — mode tabs (Instant/Expert/
  // Vision) that don't map to anything fox-harness actually has (one fixed
  // model per session, no multi-mode switching), so deliberately NOT
  // cloned (would be fake UI with nothing behind it, per the user's own
  // scope choice). Only the layout idea survives: when there's genuinely
  // nothing to show yet, center a real heading + this app's REAL composer
  // (same text input/Send button — just bigger, not new fake controls)
  // instead of pinning an empty #log above it.
  const isEmpty = entries.length === 0 && liveBubbles.size === 0;

  return (
    <div
      className={`fh-conversation-root${isEmpty ? " fh-conversation-empty" : ""}`}
    >
      {!isEmpty && (
        <div id="log" ref={logRef}>
          {entries.map((entry) => (
            <LogEntryView
              key={entry.id}
              entry={entry}
              isExpanded={(id) => expandedDetails.has(id)}
              onToggleExpanded={toggleDetailExpanded}
              t={t}
              locale={locale}
            />
          ))}
          {[...liveBubbles.entries()].map(([key, bubble]) => (
            <div key={key} className="assistant-text">
              {bubble.text.trim() && (
                <div className="assistant-text-body">
                  <Markdown text={bubble.text} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {isEmpty && (
        <div className="fh-conversation-empty-heading">
          <BrandIcon size={48} />
          <h2>{t("conversation.emptyHeading")}</h2>
        </div>
      )}
      <form id="send-form" onSubmit={onSubmit}>
        <WorkspacePanel />
        {menuItems.length > 0 && (
          <SkillMenu
            items={menuItems}
            activeIndex={activeMenuIndex}
            onChoose={chooseSkill}
            onHover={setMenuIndex}
          />
        )}
        <textarea
          id="text-input"
          ref={textareaRef}
          rows={1}
          placeholder={t("conversation.placeholder")}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setMenuIndex(0);
          }}
          onKeyDown={onTextareaKeyDown}
        />
        <div className="fh-composer-actions">
          <Button variant="primary" type="submit">
            {t("conversation.send")}
          </Button>
        </div>
      </form>
    </div>
  );
}
