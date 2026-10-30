// Chat log + composer + command palette. Was `packages/client-ui-conversation`,
// a separately-loaded UI plugin bundle (Phase 4-12); now just a component in
// the one shared app (2026-09-08 follow-up — see app/README.md for why).
// Behavior is unchanged from the pre-2026-09-08 version — only the delivery
// mechanism (separate bundle + `window.__FOX_HARNESS__`) is gone, replaced
// by `useRuntime()` (a normal React Context, app/src/runtime.ts).
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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { toast } from "sonner";

import {
  ArrowDownIcon,
  BrandIcon,
  PaperclipIcon,
  StopIcon,
} from "../../../icons.tsx";
import { translateErrorCode, useLocale } from "../../../i18n/locale.tsx";
import { randomId } from "../../../randomId.ts";
import { useRuntime } from "../../../runtime.ts";
import type {
  ServerToClient,
  StreamChunk,
  ToolResultBlock,
  WireMessage,
} from "../../../wire.ts";
import { Button } from "../../primitives/Button.tsx";
import {
  createCustomSkill,
  refreshSkillMenu,
  SkillApiError,
} from "../skills/skillsApi.ts";
import { PendingAttachments, } from "./Attachments.tsx";
import { showNoSpace } from "../settings/storageApi.ts";
import { MAX_ATTACHMENTS, useAttachments, withAttachments } from "./attachments.ts";
import type { ProgressItem } from "./DataStudioProgress.tsx";
import { StreamedMarkdown } from "./StreamedMarkdown.tsx";
import { SkillMenu, slashQuery, useSkillMenu } from "./SkillMenu.tsx";
import { WorkspaceFiles } from "../canvas/WorkspaceFiles.tsx";
import { loadCanvasHistory, parseCanvasMarker, receiveCanvasMarker, stripCanvasMarker } from "../canvas/canvas.ts";
import { useStickToBottom } from "./useStickToBottom.ts";
import { useCanvasStore } from "../canvas/store.ts";
import { ANALYZE_DATA_TOOL, buildBubbleEntry, contentToText, CREATE_SKILL_TOOL, type LiveBubble, type LogEntry, parseDataStudioMeta, parseWebSearchMeta, SKILL_TOOL, stepKey, truncate, WEB_SEARCH_TOOL, withoutRestatedAnswers } from "./logEntries.ts";
import { formatElapsed, LogEntryView, runStatusLabel } from "./LogParts.tsx";


export function Conversation({
  variant = "default",
}: {
  // docs/data-studio-agent-transfer-plan.md: "data-studio" is used only by
  // the Data Studio route (App.tsx) — same event handling/composer as
  // "default", just renders `DataStudioResultPill` always expanded.
  variant?: "default" | "data-studio";
} = {}) {
  const runtime = useRuntime();
  const { t, locale } = useLocale();
  // The canvas store follows this conversation's session; frames are handled by a listener subscribed once, so it
  // reads the session id through a ref.
  const sessionIdRef = useRef(runtime.sessionId);
  sessionIdRef.current = runtime.sessionId;
  useEffect(() => {
    const store = useCanvasStore.getState();
    if (store.sessionId !== (runtime.sessionId || undefined)) store.reset(runtime.sessionId || undefined);
  }, [runtime.sessionId]);
  useEffect(() => {
    useCanvasStore.getState().setFetch(runtime.authedFetch);
  }, [runtime.authedFetch]);
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
  // The reply in progress: set on send / `turn/start`, cleared on `turn/end`.
  // `tools` counts tool calls still waiting for their result. Drives the
  // status row under the chat and the Send ⇄ Stop button.
  // `tool`: the latest tool still running, named in the status row; `retry`: the model request failed and is being
  // retried (dsh-llm-retry's `llm/retry` event), cleared once the model answers again.
  const [run, setRun] = useState<{
    startedAt: number;
    tools: number;
    tool?: string;
    retry?: { n: number; max?: number };
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = run !== null;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // docs/chat-attachments-plan.md: files go into the chat's working directory; Data Studio has none to read them
  const canAttach = variant !== "data-studio" && !!runtime.sessionId;
  const [filesVersion, setFilesVersion] = useState(0);
  const attachments = useAttachments(
    runtime,
    () => setFilesVersion((v) => v + 1),
    (error) => showNoSpace(error, tRef.current),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragDepth, setDragDepth] = useState(0);
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
  // Same purpose as `searchCallIdsRef`, for `analyze_data` calls (routed to
  // `DataStudioResultPill` instead of a generic `ToolPill`).
  const dataStudioCallIdsRef = useRef(new Set<string>());
  // `handleEvent`/`handleFrame` below are only ever subscribed ONCE, at
  // mount (see that effect's own comment — a deliberate, load-bearing
  // design, not something i18n should break). A plain closure over `t`
  // would freeze every tool-pill/notice string at whatever language was
  // active at mount, forever, even after a later language switch — a ref
  // sidesteps that without touching the mount-once subscription at all.
  const tRef = useRef(t);
  // When the turn in progress started (its `turn/start` event's time): `turn/end` gives its file box that span.
  const turnStartedAtRef = useRef<number | undefined>(undefined);
  // The message just sent, shown at once (before the server echoes it back as `user/message`) so it can glide to
  // the top of the view without waiting a round trip; the echo then fills that same entry in, keeping its id so the
  // element on screen (the scroll anchor) stays the same one.
  const localBubbleRef = useRef<string | undefined>(undefined);
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

  const toggleDetailExpanded = useCallback((id: string): void => {
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // `live` = arrived as its own `event` frame, not replayed inside a
  // `snapshot`. Only a live create_skill result saves a skill, so reopening
  // an old chat never saves the same skill again.
  function handleEvent(
    event: { type: string; seq: number; time: number; data: unknown },
    live: boolean,
  ): void {
    if (event.seq > useCanvasStore.getState().lastSeq) useCanvasStore.setState({ lastSeq: event.seq });
    switch (event.type) {
      case "llm/retry": {
        const data = event.data as { retry: number; maxRetries?: number };
        setRun((prev) => prev && { ...prev, retry: { n: data.retry, max: data.maxRetries } });
        break;
      }
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
        // It does start the status row's clock — from the recorded time when
        // replayed, so a reload mid-reply keeps counting.
        setRun((prev) => prev ?? { startedAt: live ? Date.now() : event.time, tools: 0 });
        turnStartedAtRef.current = event.time;
        break;
      case "turn/end": {
        const data = event.data as {
          turn: number;
          reason: {
            kind: string;
            error?: { code: string; message: string };
            reason?: { kind: string };
          };
        };
        setRun(null);
        if (variant === "default" && turnStartedAtRef.current !== undefined) {
          pushEntry({ kind: "turn-files", id: `files-${event.seq}`, startedAt: turnStartedAtRef.current, endedAt: event.time });
        }
        turnStartedAtRef.current = undefined;
        const stoppedByUser = data.reason.kind === "aborted" && data.reason.reason?.kind === "user";
        if (data.reason.kind === "error" && data.reason.error) {
          pushEntry({
            kind: "notice",
            id: `evt-${event.seq}`,
            text: tRef.current("conversation.modelError", {
              code: data.reason.error.code,
              message: data.reason.error.message,
            }),
          });
        } else if (
          data.reason.kind === "aborted" &&
          data.reason.reason?.kind === "user"
        ) {
          pushEntry({
            kind: "notice",
            id: `evt-${event.seq}`,
            text: tRef.current("conversation.stopped"),
            muted: true,
          });
        } else if (data.reason.kind === "blocked") {
          // a plugin refused the next step: the data-analysis step / time limit (packages/flow/data-analysis)
          // or the session token budget (agent-core policy/quota.ts) — not a crash, so say what to do.
          pushEntry({ kind: "notice", id: `evt-${event.seq}`, text: tRef.current("conversation.turnBlocked") });
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
              (entry.pendingCalls > 0 || (stoppedByUser && entry.hasError))
            ) {
              return stoppedByUser
                ? { ...entry, pendingCalls: 0, stopped: true }
                : { ...entry, pendingCalls: 0, hasError: true };
            }
            // Same reclassification for an `analyze_data` call this turn
            // ended without ever resolving.
            if (
              entry.kind === "data-studio" &&
              entry.turn === data.turn &&
              entry.status === "running"
            ) {
              return {
                ...entry,
                status: "error",
                errorText: tRef.current("conversation.toolInterrupted"),
              };
            }
            return entry;
          }),
        );
        break;
      }
      case "user/message": {
        const message = event.data as WireMessage & { source?: { kind: string; name?: string } };
        // Context dsh appends as user messages: a `/name` skill body shows as a collapsed pill;
        // the rest (skill catalog, plugin notes) isn't for the chat.
        if (message.source?.kind === "skill-invocation" && message.source.name) {
          pushEntry({
            kind: "tool",
            id: `evt-${event.seq}`,
            turn: 0,
            name: SKILL_TOOL,
            skill: message.source.name,
            args: `/${message.source.name}`,
            status: "done",
            resultText: truncate(contentToText(message.content), 500),
          });
          break;
        }
        if (message.source && message.source.kind !== "user") break;
        const localId = live ? localBubbleRef.current : undefined;
        if (localId) {
          localBubbleRef.current = undefined;
          const echoed = buildBubbleEntry(localId, "user", message.content);
          setEntries((prev) =>
            prev.some((entry) => entry.id === localId)
              ? prev.flatMap((entry) => (entry.id !== localId ? [entry] : echoed ? [echoed] : []))
              : echoed ? [...prev, echoed] : prev,
          );
          break;
        }
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
        setRun((prev) => (prev?.retry ? { ...prev, retry: undefined } : prev));
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
        setRun((prev) => prev && { ...prev, tools: prev.tools + 1, tool: data.name, retry: undefined });
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
        if (data.name === ANALYZE_DATA_TOOL) {
          dataStudioCallIdsRef.current.add(data.callId);
          let question = "";
          try {
            question = (JSON.parse(data.arguments) as { question?: string }).question ?? "";
          } catch {
            // not valid JSON (or empty) — leave blank, the pill still renders fine
          }
          pushEntry({
            kind: "data-studio",
            id: `tool-${data.callId}`,
            turn: data.turn,
            status: "running",
            startedAt: Date.now(),
            question,
            sql: null,
            columns: [],
            rows: [],
            rowCount: 0,
            chart: null,
            chartId: null,
            charts: [],
            assumptions: [],
            followUps: [],
            truncated: false,
            progress: [],
          });
          break;
        }
        let pretty = data.arguments;
        let skill: string | undefined;
        try {
          const parsed = JSON.parse(data.arguments);
          pretty = JSON.stringify(parsed, null, 2);
          if (data.name === SKILL_TOOL && typeof parsed?.name === "string") skill = parsed.name;
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
          ...(skill ? { skill } : {}),
        });
        if (data.name === CREATE_SKILL_TOOL) {
          skillCallArgsRef.current.set(data.callId, data.arguments);
        }
        break;
      }
      case "fox/data-studio-progress": {
        // one step of a running analyze_data call (packages/tool/data-studio-agent appends these log-only events)
        const data = event.data as { callId: string; item: ProgressItem };
        updateEntry(`tool-${data.callId}`, (entry) =>
          entry.kind === "data-studio" ? { ...entry, progress: [...entry.progress, data.item] } : entry,
        );
        break;
      }
      case "tool/result": {
        const data = event.data as {
          turn: number;
          message: { content: [ToolResultBlock] };
          error?: { message?: string; name: string };
          meta?: unknown;
        };
        setRun((prev) => {
          if (!prev) return prev;
          const tools = Math.max(0, prev.tools - 1);
          return { ...prev, tools, tool: tools === 0 ? undefined : prev.tool };
        });
        const block = data.message.content[0];
        const callId = block?.toolCallId;
        const isError = !!(data.error || block?.isError);
        // `searchCallIdsRef.delete()` both checks AND consumes membership —
        // a `web_search` result is routed here exactly once, same as any
        // other tool's `tool/result`.
        if (callId && dataStudioCallIdsRef.current.delete(callId)) {
          const parsed = isError ? undefined : parseDataStudioMeta(data.meta);
          const dataStudioResultText = block ? contentToText(block.content) : "";
          updateEntry(`tool-${callId}`, (entry) =>
            entry.kind === "data-studio"
              ? {
                  ...entry,
                  status: isError || !parsed ? "error" : "done",
                  answer: isError ? undefined : dataStudioResultText,
                  errorText: isError
                    ? (data.error?.message ?? data.error?.name ?? dataStudioResultText)
                    : undefined,
                  sql: parsed?.sql ?? null,
                  columns: parsed?.columns ?? [],
                  rows: parsed?.rows ?? [],
                  rowCount: parsed?.rowCount ?? 0,
                  chart: parsed?.chart ?? null,
                  chartId: parsed?.chartId ?? null,
                  charts: parsed?.charts ?? [],
                  assumptions: parsed?.assumptions ?? [],
                  followUps: parsed?.followUps ?? [],
                  truncated: parsed?.truncated ?? false,
                }
              : entry,
          );
          break;
        }
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
        const marker = isError ? undefined : parseCanvasMarker(event);
        if (marker && callId) {
          setEntries((prev) =>
            prev.map((entry) =>
              entry.id === `tool-${callId}`
                ? { kind: "canvas", id: entry.id, canvasId: marker.id, canvasKind: marker.kind, path: marker.path, title: marker.title, version: marker.version }
                : entry,
            ),
          );
          if (sessionIdRef.current) receiveCanvasMarker(sessionIdRef.current, marker, event.seq);
          break;
        }
        const blockText = block ? stripCanvasMarker(contentToText(block.content)) : "";
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
        jumpPendingRef.current = true;
        localBubbleRef.current = undefined;
        useCanvasStore.getState().reset(sessionIdRef.current || undefined);
        setEntries([]);
        setLiveBubbles(new Map());
        setRun(null);
        pendingDeltasRef.current.clear();
        for (const event of frame.events) handleEvent(event, false);
        // the panel's own history (saved edits, file snapshots): docs/canvas-storage-plan.md
        if (sessionIdRef.current) void loadCanvasHistory(sessionIdRef.current).catch(() => undefined);
        break;
      case "event":
        handleEvent(frame.event, true);
        break;
      case "error":
        // Errors answer something this tab sent (e.g. no live agent), so the
        // reply it was waiting for isn't coming.
        setRun(null);
        pushEntry({
          kind: "notice",
          id: `err-${randomId()}`,
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

  // Scrolling (useStickToBottom.ts): follow new content only while the reader is at the bottom.
  // The room under a just-sent message so it can sit at the top of the view (useStickToBottom.ts anchorToLatest).
  const spacerRef = useRef<HTMLDivElement>(null);
  const { atBottom, scrollToBottom, jumpToBottom, anchorToLatest } = useStickToBottom(logRef, spacerRef);
  const anchorSent = () => anchorToLatest(":scope > .fh-user-message");

  // The composer floats over the log's end (style.css .fh-composer-dock): the log keeps `--fh-dock-height` free at
  // its end so the last message scrolls clear of it, and the scroll-to-latest button sits above it. A classic
  // (non-overlay) scrollbar takes its width out of the log's right side, so `--fh-log-scrollbar` is taken back out
  // of the log's right padding and the dock's, keeping messages, files box and composer the same width (user,
  // 2026-10-28: "box chat và box folder ở cuối chat đang dài hơn về bên phải so với đoạn chat"). Both are
  // re-measured whenever the dock grows (a long draft, the files box) or the scrollbar appears or goes.
  const dockRef = useRef<HTMLDivElement>(null);
  const logMounted = entries.length > 0 || liveBubbles.size > 0 || !!run;
  useEffect(() => {
    const dock = dockRef.current;
    const root = dock?.parentElement;
    if (!dock || !root) return;
    const log = logRef.current;
    const measure = () => {
      root.style.setProperty("--fh-dock-height", `${dock.offsetHeight}px`);
      root.style.setProperty("--fh-log-scrollbar", `${log ? log.offsetWidth - log.clientWidth : 0}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    if (log) observer.observe(log);
    return () => observer.disconnect();
  }, [logMounted]);
  // A chat just opened (its snapshot replayed): land at the end once it has rendered, without animating.
  const jumpPendingRef = useRef(false);
  useEffect(() => {
    if (!jumpPendingRef.current) return;
    jumpPendingRef.current = false;
    requestAnimationFrame(jumpToBottom);
  }, [entries, jumpToBottom]);

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

  function addFiles(files: Iterable<File>): void {
    if (!canAttach || run) return;
    const left = attachments.add(files);
    if (left > 0) toast.error(t("attach.tooMany", { n: String(MAX_ATTACHMENTS) }));
  }

  function sendMessage(): void {
    const trimmed = text.trim();
    // One reply at a time: while it runs the button is Stop and Enter waits. Attachments must finish uploading.
    if ((!trimmed && attachments.ready === 0) || run || !runtime.connected || attachments.uploading) return;
    const sent = withAttachments(trimmed, attachments.take());
    runtime.send({ type: "followup", text: sent });
    if (sent.trim()) {
      const id = `local-${Date.now()}`;
      localBubbleRef.current = id;
      pushEntry({ kind: "bubble", id, role: "user", text: sent.trim() });
    }
    setText("");
    // the reader's own message goes to the top of the view, the reply fills in below it
    anchorSent();
    // The status row shows right away instead of waiting for `turn/start`.
    setRun({ startedAt: Date.now(), tools: 0 });
  }

  function stopRun(): void {
    runtime.send({ type: "cancel" });
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
  const isEmpty = entries.length === 0 && liveBubbles.size === 0 && !run;
  // Stable props for the memoized LogEntryView (docs/ui-performance-plan.md §6): they change only when what they
  // read changes, not on every streaming frame.
  const shownEntries = useMemo(
    () => (variant === "data-studio" ? withoutRestatedAnswers(entries) : entries),
    [entries, variant],
  );
  const isExpanded = useCallback((id: string) => expandedDetails.has(id), [expandedDetails]);
  const followUpRef = useRef<(question: string) => void>(() => {});
  followUpRef.current = (question) => {
    runtime.send({ type: "followup", text: question });
    anchorSent();
  };
  const onFollowUp = useCallback((question: string) => followUpRef.current(question), []);
  // Streaming text already shows the reply is alive — the status row steps
  // aside until the text stops (next step or tool).
  const streaming = [...liveBubbles.values()].some((bubble) => bubble.text.trim());

  return (
    <div
      className={`fh-conversation-root${isEmpty ? " fh-conversation-empty" : ""}`}
    >
      {!isEmpty && (
        <div id="log" ref={logRef}>
          {shownEntries.map((entry) => (
            <LogEntryView
              key={entry.id}
              entry={entry}
              isExpanded={isExpanded}
              onToggleExpanded={toggleDetailExpanded}
              alwaysExpandDataStudio={variant === "data-studio"}
              onFollowUp={onFollowUp}
              t={t}
              locale={locale}
            />
          ))}
          {[...liveBubbles.entries()].map(([key, bubble]) => (
            <div key={key} className="assistant-text">
              {bubble.text.trim() && (
                <div className="assistant-text-body">
                  <StreamedMarkdown id={key} text={bubble.text} live />
                </div>
              )}
            </div>
          ))}
          {run && (!streaming || !runtime.connected) && (
            <div className="fh-run-status" role="status">
              {runtime.connected ? (
                <>
                  <span className="fh-run-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>{runStatusLabel(run, t)}</span>
                  <span className="fh-run-elapsed">
                    {formatElapsed(now - run.startedAt, t)}
                  </span>
                </>
              ) : (
                <span>{t("conversation.disconnectedWhileRunning")}</span>
              )}
            </div>
          )}
          <div ref={spacerRef} className="fh-log-spacer" aria-hidden="true" />
        </div>
      )}
      {isEmpty && (
        <div className="fh-conversation-empty-heading">
          <BrandIcon size={48} />
          <h2>{t("conversation.emptyHeading")}</h2>
        </div>
      )}
      {/* the files box and the composer float over the log's end (style.css .fh-composer-dock) */}
      <div className="fh-composer-dock" ref={dockRef}>
        {/* the reader is above the end: one click glides back down and follows again;
        it rides just above the files box / composer (style.css .fh-composer-dock > .fh-scroll-latest) */}
        {!atBottom && (
          <button
            type="button"
            className="fh-scroll-latest"
            onClick={scrollToBottom}
            title={t("conversation.scrollToLatest")}
            aria-label={t("conversation.scrollToLatest")}
          >
            <ArrowDownIcon size={16} />
          </button>
        )}
        {variant === "default" && <WorkspaceFiles version={filesVersion} running={!!run} />}
        <form
          id="send-form"
          onSubmit={onSubmit}
          onDragEnter={(event) => {
            if (!canAttach || !event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDragDepth((d) => d + 1);
          }}
          onDragOver={(event) => {
            if (canAttach && event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
          onDrop={(event) => {
            if (!canAttach) return;
            event.preventDefault();
            setDragDepth(0);
            addFiles(event.dataTransfer.files);
          }}
        >
          {dragDepth > 0 && <div className="fh-composer-drop-hint">{t("attach.dropHint")}</div>}
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
            onPaste={(event) => {
              // a pasted screenshot or copied file attaches; pasted text stays text
              if (!canAttach || event.clipboardData.files.length === 0) return;
              event.preventDefault();
              addFiles(event.clipboardData.files);
            }}
          />
          <PendingAttachments items={attachments.items} onRemove={attachments.remove} onRetry={attachments.retry} t={t} />
          <div className="fh-composer-actions">
            {canAttach && (
              <>
                <button
                  type="button"
                  className="fh-attach-button"
                  title={t("attach.button")}
                  aria-label={t("attach.button")}
                  disabled={!!run}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon size={18} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.target.files) addFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </>
            )}
            {run && runtime.connected ? (
              <Button
                key="stop"
                variant="primary"
                className="fh-stop-btn"
                onClick={stopRun}
              >
                <StopIcon size={12} fill="currentColor" />
                {t("conversation.stop")}
              </Button>
            ) : (
              <Button key="send" variant="primary" type="submit" disabled={attachments.uploading}>
                {t("conversation.send")}
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
