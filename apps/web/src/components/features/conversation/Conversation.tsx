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
  useEffect,
  useRef,
  useState,
} from "react";

import { BrandIcon, ChevronDownIcon, ToolIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
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

// ---- Declarative log state.

type LogEntry =
  | { kind: "notice"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: string;
      status: "running" | "done" | "error";
      resultText: string | null;
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

function buildBubbleEntry(
  id: string,
  role: "user" | "assistant",
  content: ContentBlock[],
): LogEntry | undefined {
  const text = contentToText(content);
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
            <div className="tool-pill-result">{entry.resultText}</div>
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
}: {
  entry: LogEntry;
  isExpanded: (id: string) => boolean;
  onToggleExpanded: (id: string) => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
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
            <div className="assistant-text-body">{entry.text}</div>
          )}
        </div>
      );
  }
}

export function Conversation() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [liveBubbles, setLiveBubbles] = useState<Map<string, LiveBubble>>(
    new Map(),
  );
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(
    new Set(),
  );
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  function toggleDetailExpanded(id: string): void {
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleEvent(event: {
    type: string;
    seq: number;
    data: unknown;
  }): void {
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
        const data = event.data as { turn: number; reason: { kind: string } };
        if (data.reason.kind !== "completed") {
          pushEntry({
            kind: "notice",
            id: `evt-${event.seq}`,
            text: tRef.current("conversation.turnEnded", {
              n: String(data.turn),
              reason: data.reason.kind,
            }),
          });
        }
        break;
      }
      case "user/message": {
        const message = event.data as WireMessage;
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
          setLiveBubbles((prev) => {
            const next = new Map(prev);
            const existing = next.get(key) ?? { text: "" };
            next.set(key, { ...existing, text: existing.text + textDelta });
            return next;
          });
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
          callId: string;
          name: string;
          arguments: string;
        };
        let pretty = data.arguments;
        try {
          pretty = JSON.stringify(JSON.parse(data.arguments), null, 2);
        } catch {
          // not valid JSON (or empty) — show raw
        }
        pushEntry({
          kind: "tool",
          id: `tool-${data.callId}`,
          name: data.name,
          args: pretty,
          status: "running",
          resultText: null,
        });
        break;
      }
      case "tool/result": {
        const data = event.data as {
          message: { content: [ToolResultBlock] };
          error?: { message?: string; name: string };
        };
        const block = data.message.content[0];
        const blockText = block ? contentToText(block.content) : "";
        const isError = !!(data.error || block?.isError);
        const resultText = isError
          ? (data.error?.name ?? blockText)
          : truncate(blockText, 500);
        // `block?.toolCallId` (real field, `ToolResultBlock` — same .d.ts
        // as above) is the SAME id `tool/call` above used to push this
        // entry, so this always finds and completes the right pill even
        // with several tool calls in flight in the same turn.
        updateEntry(`tool-${block?.toolCallId}`, (entry) =>
          entry.kind === "tool"
            ? { ...entry, status: isError ? "error" : "done", resultText }
            : entry,
        );
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
        for (const event of frame.events) handleEvent(event);
        break;
      case "event":
        handleEvent(frame.event);
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
            />
          ))}
          {[...liveBubbles.entries()].map(([key, bubble]) => (
            <div key={key} className="assistant-text">
              {bubble.text && (
                <div className="assistant-text-body">{bubble.text}</div>
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
        <textarea
          id="text-input"
          ref={textareaRef}
          rows={1}
          placeholder={t("conversation.placeholder")}
          value={text}
          onChange={(event) => setText(event.target.value)}
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
