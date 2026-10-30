// How each chat log entry is drawn — tool pills, web-search sources, Data Studio results, the entry view itself
// (split out of Conversation.tsx, docs/ui-performance-plan.md §5). The data side is logEntries.ts.
import { memo, type ReactNode, useEffect, useState } from "react";


import {
  ChevronDownIcon,
  DataAnalysisIcon,
  FileTextIcon,
  FolderIcon,
  PencilIcon,
  SearchIcon,
  SkillIcon,
  ToolIcon,
} from "../../../icons.tsx";
import type { Locale, TranslationKey } from "../../../i18n/translations.ts";
import { SentAttachments } from "./Attachments.tsx";
import { splitAttachments, } from "./attachments.ts";
import { ChartView, } from "./ChartView.tsx";
import { DataStudioAnswer, PinToDashboardButton } from "./DataStudioAnswer.tsx";
import { Markdown } from "./Markdown.tsx";
import { StreamedMarkdown } from "./StreamedMarkdown.tsx";
import { CanvasChip, } from "../canvas/CanvasChip.tsx";
import { TurnFiles, } from "../canvas/TurnFiles.tsx";
import { type LogEntry, rowsToMarkdownTable, type WebSource } from "./logEntries.ts";


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
export const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')\]]+)/g;

export function linkify(text: string): ReactNode[] {
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
        className="fh-link [color:var(--accent-text)] [text-decoration:underline] [&&]:[text-decoration-color:color-mix(in_srgb,currentColor_40%,transparent)] [text-underline-offset:0.15em] [word-break:break-all] [&:hover]:[text-decoration-color:currentColor]"
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

// Collapsed by default — `expanded`/`onToggle` are lifted to Conversation's
// own state (`expandedDetails`, a `Set<id>` — was shared with a reasoning
// toggle too until that was removed entirely, 2026-09-10; kept as a
// generic `Set` rather than reverting to a tool-pill-only name in case
// something else needs the same "collapsed detail" pattern later) rather
// than living on the `LogEntry` itself, since expand/collapse is pure
// local UI state, not server-log data (same separation `liveBubbles`
// already keeps from `entries`).
// The file tools (docs/file-tools-plan.md §4.5) say what they did in words — "Read data/a.csv", "Moved a → b" —
// instead of "Used read" with the arguments as JSON.
export const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "file_manage"]);
export const FILE_MANAGE_LABELS: Record<string, TranslationKey> = {
  list: "fileTool.list",
  mkdir: "fileTool.mkdir",
  move: "fileTool.move",
  copy: "fileTool.copy",
  delete: "fileTool.delete",
  zip: "fileTool.zip",
  unzip: "fileTool.unzip",
};

// A word past this length (a path, an id) in a tool pill's title may break anywhere (user, 2026-10-28): the line
// breaker only breaks a path like `data/users/2/38635216-b111-4b18-…/dummy-charts.html` at its few allowed spots, so
// it jumped to the next line whole and left a long gap at the end of the line before. Short words still wrap whole.
export const LONG_WORD_CHARS = 32;

export function breakLongWords(text: string): ReactNode {
  if (!text.split(" ").some((word) => word.length > LONG_WORD_CHARS)) return text;
  return text.split(/( )/).map((part, index) =>
    part.length > LONG_WORD_CHARS ? <span key={index} className="fh-break-anywhere [word-break:break-all]">{part}</span> : part,
  );
}

export function fileToolLabel(
  name: string,
  argsJson: string,
  t: (key: TranslationKey, params?: Record<string, string>) => string,
): { text: string; icon: typeof ToolIcon } | undefined {
  if (!FILE_TOOLS.has(name)) return undefined;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  const short = (path: string) => (path.length > 60 ? `…${path.slice(-58)}` : path) || ".";
  switch (name) {
    case "read":
      return { text: t("fileTool.read", { target: short(str("file_path")) }), icon: FileTextIcon };
    case "write":
      return { text: t("fileTool.write", { target: short(str("file_path")) }), icon: PencilIcon };
    case "edit":
      return { text: t("fileTool.edit", { target: short(str("file_path")) }), icon: PencilIcon };
    case "glob":
      return { text: t("fileTool.glob", { pattern: str("pattern") }), icon: SearchIcon };
    case "grep":
      return { text: t("fileTool.grep", { pattern: str("pattern") }), icon: SearchIcon };
    default: {
      const key = FILE_MANAGE_LABELS[str("action")];
      if (!key) return undefined;
      return { text: t(key, { target: short(str("path")), to: short(str("to")) }), icon: FolderIcon };
    }
  }
}

export function ToolPill({
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
  const params = { name: entry.skill ?? entry.name };
  const file = entry.skill ? undefined : fileToolLabel(entry.name, entry.args, t);
  // A failed call reads like a finished one (user, 2026-10-28: don't show failed tool pills to the user): the agent
  // usually tries again or works around it; what went wrong is still in the details when the pill is opened.
  const label = file
    ? entry.status === "running"
      ? `${file.text}…`
      : file.text
    : entry.status === "running"
      ? t(entry.skill ? "conversation.skillLoading" : "conversation.toolRunning", params)
      : t(entry.skill ? "conversation.skillLoaded" : "conversation.toolUsed", params);
  const Icon = entry.skill ? SkillIcon : (file?.icon ?? ToolIcon);
  return (
    <div
      className={`tool-pill self-start [max-width:85%] [border-radius:12px] [background:var(--bg-raised)] [border:1px_solid_var(--border-subtle)] [font-size:0.85em] overflow-hidden [&.expanded_.tool-pill-chevron]:[transform:rotate(180deg)]${entry.status === "error" ? " tool-pill-error" : ""}${expanded ? " expanded" : ""}`}
    >
      <button type="button" className="tool-pill-header flex items-center [gap:0.5em] w-full [height:auto] [min-height:34px] [padding:0.5em_0.8em] [background:transparent] [border:none] [color:var(--muted)] text-left cursor-pointer [&>svg]:flex-none [&:hover]:[background:var(--bg-hover)]" onClick={onToggle}>
        <Icon size={13} />
        <span>{breakLongWords(label)}</span>
        <ChevronDownIcon size={13} className="tool-pill-chevron [margin-left:auto] flex-none [transition:transform_var(--duration-fast)_var(--ease)]" />
      </button>
      {expanded && (
        <div className="tool-pill-detail [padding:0_0.8em_0.7em] [border-top:1px_solid_var(--border-subtle)] [margin-top:0.1em] [&&]:[padding-top:0.6em] [font-family:ui-monospace,monospace] [font-size:0.9em] whitespace-pre-wrap [word-break:break-word] [color:var(--muted)] [max-height:320px] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:[width:8px] [&::-webkit-scrollbar-thumb]:[background:var(--border)] [&::-webkit-scrollbar-thumb]:[border-radius:999px] [&::-webkit-scrollbar-thumb:hover]:[background:var(--muted)] [&::-webkit-scrollbar-track]:[background:transparent]">
          <div className="tool-pill-args [margin-bottom:0.5em]">{entry.args}</div>
          {entry.resultText && (
            <div className="tool-pill-result">{linkify(entry.resultText)}</div>
          )}
        </div>
      )}
    </div>
  );
}

// `undefined` on a malformed URL — callers fall back to the raw string.
export function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

// Fallback label when a source has no `title` — bare hostname reads better
// than a raw URL in a link's visible text (matches the real dsh reference
// UI's own `sourceLabel()`/`Dd()` behavior found while researching this).
export function sourceLabel(source: WebSource): string {
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
export const RELATIVE_TIME_RE = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
export const VI_TIME_UNIT: Record<string, string> = {
  second: "giây",
  minute: "phút",
  hour: "giờ",
  day: "ngày",
  week: "tuần",
  month: "tháng",
  year: "năm",
};

export function formatPublishedAt(raw: string, locale: Locale): string {
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
export function SearchSourcesPill({
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
      : entry.stopped
        ? t("conversation.searchStopped")
        : isError
        ? t("conversation.searchFailed")
        : entry.sources.length === 0
          ? t("conversation.searchEmpty")
          : t("conversation.searched", { n: String(entry.sources.length) });
  return (
    <div
      className={`tool-pill self-start [max-width:85%] [border-radius:12px] [background:var(--bg-raised)] [border:1px_solid_var(--border-subtle)] [font-size:0.85em] overflow-hidden [&.expanded_.tool-pill-chevron]:[transform:rotate(180deg)] search-pill${isError ? " tool-pill-error" : ""}${expanded ? " expanded" : ""}`}
    >
      <button type="button" className="tool-pill-header flex items-center [gap:0.5em] w-full [height:auto] [min-height:34px] [padding:0.5em_0.8em] [background:transparent] [border:none] [color:var(--muted)] text-left cursor-pointer [&>svg]:flex-none [&:hover]:[background:var(--bg-hover)]" onClick={onToggle}>
        <SearchIcon size={13} />
        <span>{label}</span>
        <ChevronDownIcon size={13} className="tool-pill-chevron [margin-left:auto] flex-none [transition:transform_var(--duration-fast)_var(--ease)]" />
      </button>
      {expanded && entry.sources.length > 0 && (
        <div className="tool-pill-detail [padding:0_0.8em_0.7em] [border-top:1px_solid_var(--border-subtle)] [margin-top:0.1em] [&&]:[padding-top:0.6em] [font-size:0.9em] [word-break:break-word] [color:var(--muted)] [max-height:320px] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:[width:8px] [&::-webkit-scrollbar-thumb]:[background:var(--border)] [&::-webkit-scrollbar-thumb]:[border-radius:999px] [&::-webkit-scrollbar-thumb:hover]:[background:var(--muted)] [&::-webkit-scrollbar-track]:[background:transparent] search-pill-detail [font-family:var(--fh-font,inherit)] whitespace-normal">
          <ol className="search-pill-list m-0 [padding-inline-start:1.4em] [&_li]:[margin:0_0_0.7em] [&_li:last-child]:[margin-bottom:0]">
            {entry.sources.map((source, index) => (
              <li key={`${source.url}-${index}`}>
                <a
                  className="fh-link [color:var(--accent-text)] [text-decoration:underline] [&&]:[text-decoration-color:color-mix(in_srgb,currentColor_40%,transparent)] [text-underline-offset:0.15em] [word-break:break-all] [&:hover]:[text-decoration-color:currentColor] search-pill-source-link font-medium"
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={hostnameOf(source.url) ?? source.url}
                >
                  {sourceLabel(source)}
                </a>
                {source.snippet && (
                  <div className="search-pill-snippet [margin-top:0.15em] [color:var(--muted)]">{source.snippet}</div>
                )}
                {source.publishedAt && (
                  <div className="search-pill-published [margin-top:0.15em] [font-size:0.85em] [color:var(--muted)]">
                    {formatPublishedAt(source.publishedAt, locale)}
                  </div>
                )}
              </li>
            ))}
          </ol>
          {entry.truncated && (
            <div className="search-pill-truncated [margin-top:0.6em] [padding-top:0.5em] [border-top:1px_solid_var(--border-subtle)] [font-size:0.85em] [color:var(--muted)] italic">
              {t("conversation.searchTruncated")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// docs/data-studio-agent-transfer-plan.md — result pill for `analyze_data` (default chat only; the Data Studio
// route renders `DataStudioAnswer` inline instead). Collapsed by default, same `expandedDetails`/
// `toggleDetailExpanded` state every other pill in this file uses.
export function DataStudioResultPill({
  entry,
  expanded,
  onToggle,
  alwaysExpanded,
  t,
}: {
  entry: Extract<LogEntry, { kind: "data-studio" }>;
  expanded: boolean;
  onToggle: () => void;
  // docs/data-studio-agent-transfer-plan.md: the Data Studio route's own
  // chat (Conversation `variant="data-studio"`) always shows trace/SQL/
  // table/chart inline instead of collapsing into a click-to-open pill —
  // same underlying markup either way, just the header loses its toggle
  // affordance and the detail section is never hidden.
  alwaysExpanded?: boolean;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
}) {
  // Real calls routinely run 1-10+ minutes (the Python pipeline's own multi-
  // agent retrieval/SQL/chart steps) — a static label with no feedback for
  // that whole time reads as frozen. Ticks once a second only while running;
  // no interval/re-render cost once it settles.
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - entry.startedAt);
  useEffect(() => {
    if (entry.status !== "running") return;
    const id = setInterval(() => setElapsedMs(Date.now() - entry.startedAt), 1000);
    return () => clearInterval(id);
  }, [entry.status, entry.startedAt]);
  const elapsedLabel = (() => {
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  })();
  const label =
    entry.status === "running"
      ? `${t("conversation.dataStudioRunning")} (${elapsedLabel})`
      : entry.status === "error"
        ? t("conversation.dataStudioFailed")
        : t("conversation.dataStudioDone");
  const isOpen = alwaysExpanded || expanded;
  return (
    <div
      className={`tool-pill self-start [max-width:85%] [border-radius:12px] [background:var(--bg-raised)] [border:1px_solid_var(--border-subtle)] [font-size:0.85em] overflow-hidden [&.expanded_.tool-pill-chevron]:[transform:rotate(180deg)] data-studio-pill${entry.status === "error" ? " tool-pill-error" : ""}${isOpen ? " expanded" : ""}${alwaysExpanded ? " data-studio-pill-static [&_.tool-pill-header]:cursor-default" : ""}`}
    >
      {alwaysExpanded ? (
        <div className="tool-pill-header flex items-center [gap:0.5em] w-full [height:auto] [min-height:34px] [padding:0.5em_0.8em] [background:transparent] [border:none] [color:var(--muted)] text-left cursor-pointer [&>svg]:flex-none [&:hover]:[background:var(--bg-hover)]">
          <DataAnalysisIcon size={13} />
          <span>{label}</span>
        </div>
      ) : (
        <button type="button" className="tool-pill-header flex items-center [gap:0.5em] w-full [height:auto] [min-height:34px] [padding:0.5em_0.8em] [background:transparent] [border:none] [color:var(--muted)] text-left cursor-pointer [&>svg]:flex-none [&:hover]:[background:var(--bg-hover)]" onClick={onToggle}>
          <DataAnalysisIcon size={13} />
          <span>{label}</span>
          <ChevronDownIcon size={13} className="tool-pill-chevron [margin-left:auto] flex-none [transition:transform_var(--duration-fast)_var(--ease)]" />
        </button>
      )}
      {isOpen && (
        <div className="tool-pill-detail [padding:0_0.8em_0.7em] [border-top:1px_solid_var(--border-subtle)] [margin-top:0.1em] [&&]:[padding-top:0.6em] [font-size:0.9em] [word-break:break-word] [color:var(--muted)] [max-height:320px] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:[width:8px] [&::-webkit-scrollbar-thumb]:[background:var(--border)] [&::-webkit-scrollbar-thumb]:[border-radius:999px] [&::-webkit-scrollbar-thumb:hover]:[background:var(--muted)] [&::-webkit-scrollbar-track]:[background:transparent] data-studio-pill-detail [font-family:var(--fh-font,inherit)] whitespace-normal flex flex-col [gap:0.9em]">
          {entry.status === "error" && entry.errorText && (
            <div className="data-studio-error [color:var(--muted)]">{entry.errorText}</div>
          )}
          {entry.answer && <Markdown text={entry.answer} />}
          {entry.chart && <ChartView chart={entry.chart} />}
          {entry.chartId !== null && <PinToDashboardButton chartId={entry.chartId} t={t} />}
          {entry.sql && <Markdown text={`\`\`\`sql\n${entry.sql}\n\`\`\``} />}
          {entry.rows.length > 0 && (
            <Markdown text={rowsToMarkdownTable(entry.columns, entry.rows)} />
          )}
          {entry.truncated && (
            <div className="data-studio-truncated [padding-top:0.5em] [border-top:1px_solid_var(--border-subtle)] [font-size:0.85em] [color:var(--muted)] italic">
              {t("conversation.dataStudioTruncated", { n: String(entry.rowCount) })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// What the status row says the agent is doing: retrying the model, running a named tool, or thinking.
export const TOOL_LABELS: Partial<Record<string, TranslationKey>> = {
  python: "tool.python",
  web_search: "tool.web_search",
  canvas_write: "tool.canvas_write",
  read: "tool.read",
  write: "tool.write",
  edit: "tool.edit",
  glob: "tool.search_files",
  grep: "tool.search_files",
  file_manage: "tool.file_manage",
  skill: "tool.skill",
  analyze_data: "tool.analyze_data",
};

export function runStatusLabel(
  run: { tools: number; tool?: string; retry?: { n: number; max?: number } },
  t: (key: TranslationKey, params?: Record<string, string>) => string,
): string {
  if (run.retry) return t("conversation.retrying", { n: String(run.retry.n), max: run.retry.max === undefined ? "∞" : String(run.retry.max) });
  if (run.tools === 0) return t("conversation.thinking");
  const key = run.tool === undefined ? undefined : TOOL_LABELS[run.tool];
  return key ? t("conversation.runningNamed", { what: t(key) }) : t("conversation.runningTool");
}

export function formatElapsed(
  ms: number,
  t: (key: TranslationKey, params?: Record<string, string>) => string,
): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0
    ? t("conversation.elapsedSeconds", { s: String(seconds) })
    : t("conversation.elapsedMinutes", {
        m: String(minutes),
        s: String(seconds).padStart(2, "0"),
      });
}

// Memoized (docs/ui-performance-plan.md §6): while a reply streams, Conversation re-renders every animation frame;
// finished entries keep the same props and are skipped, so a frame costs the live bubble, not the whole history.
export const LogEntryView = memo(function LogEntryView({
  entry,
  isExpanded,
  onToggleExpanded,
  alwaysExpandDataStudio,
  onFollowUp,
  t,
  locale,
}: {
  entry: LogEntry;
  isExpanded: (id: string) => boolean;
  onToggleExpanded: (id: string) => void;
  alwaysExpandDataStudio: boolean;
  onFollowUp: (question: string) => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
  locale: Locale;
}) {
  switch (entry.kind) {
    case "notice":
      return (
        <div className={`notice self-center [font-size:0.8em] [color:var(--error)]${entry.muted ? " notice-muted [color:var(--muted)]" : ""}`}>
          {entry.text}
        </div>
      );
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
    case "data-studio":
      // The Data Studio route shows the reply inline (answer, SQL toggle, chart switcher, suggestions)
      // like a normal assistant message; the default chat keeps the collapsible pill.
      if (alwaysExpandDataStudio) return <DataStudioAnswer entry={entry} onFollowUp={onFollowUp} t={t} />;
      return (
        <DataStudioResultPill
          entry={entry}
          expanded={isExpanded(entry.id)}
          onToggle={() => onToggleExpanded(entry.id)}
          alwaysExpanded={alwaysExpandDataStudio}
          t={t}
        />
      );
    case "canvas":
      return <CanvasChip entry={entry} />;
    case "turn-files":
      return <TurnFiles entry={entry} />;
    case "bubble":
      if (entry.role === "user") {
        // a message with attachments ends with their marker line (attachments.ts): cards above the text
        const { text, names } = splitAttachments(entry.text);
        return (
          <div className="fh-user-message self-end flex flex-col items-end [gap:0.4em] [max-width:85%] [&_.bubble]:[max-width:100%]">
            {names.length > 0 && <SentAttachments names={names} t={t} />}
            {text && (
              <div className="bubble [max-width:85%] [padding:0.55em_0.8em] [border-radius:22px] [box-shadow:var(--shadow-lv1)] whitespace-pre-wrap [word-break:break-word] bubble-user self-end [background:var(--bubble-user)]">
                <span>{text}</span>
              </div>
            )}
          </div>
        );
      }
      return (
        <div className="assistant-text [max-width:100%] [word-break:break-word]">
          {entry.text && (
            <div className="assistant-text-body [color:var(--fg)] [&_:is(h1,h2,h3,h4,h5,h6)]:[margin:0.9em_0_0.4em] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:[line-height:1.3] [&_:is(h1,h2,h3,h4,h5,h6):first-child]:[margin-top:0] [&_h1]:[font-size:1.35em] [&_h2]:[font-size:1.2em] [&_:is(h3,h4,h5,h6)]:[font-size:1.05em] [&_p]:[margin:0.5em_0] [&_p:first-child]:[margin-top:0] [&_p:last-child]:[margin-bottom:0] [&_:is(ul,ol)]:[margin:0.5em_0] [&_:is(ul,ol)]:[padding-inline-start:1.4em] [&_li]:[margin:0.2em_0] [&_li>:is(ul,ol)]:[margin:0.2em_0] [&_blockquote]:[margin:0.6em_0] [&_blockquote]:[padding:0.1em_0_0.1em_0.9em] [&_blockquote]:[border-left:3px_solid_var(--border)] [&_blockquote]:[color:var(--muted)] [&_hr]:[margin:1em_0] [&_hr]:[border:none] [&&_hr]:[border-top:1px_solid_var(--border)] [&_strong]:font-semibold [&_.md-inline-code]:[background:var(--surface)] [&_.md-inline-code]:[border:1px_solid_var(--border-subtle)] [&_.md-inline-code]:[border-radius:4px] [&_.md-inline-code]:[padding:0.1em_0.35em] [&_.md-inline-code]:[font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace] [&_.md-inline-code]:[font-size:0.9em]">
              {/* carries on revealing a reply that was streaming a moment ago; history shows at once */}
              <StreamedMarkdown id={entry.id} text={entry.text} />
            </div>
          )}
        </div>
      );
  }
});
