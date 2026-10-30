

import type {
  ContentBlock,
  TextBlock,
} from "../../../wire.ts";
import { type ChartSpec } from "./ChartView.tsx";
import type { ProgressItem } from "./DataStudioProgress.tsx";
import { type CanvasChipEntry } from "../canvas/CanvasChip.tsx";
import { type TurnFilesEntry } from "../canvas/TurnFiles.tsx";


// docs/skill-transfer-plan.md, giai đoạn 3: the `create_skill` tool only
// validates inside the worker, which never knows who the user is. The browser,
// already signed in as that user, does the actual save.
export const CREATE_SKILL_TOOL = "create_skill";

// Real upstream tool name (`@deepseek-ai/dsh-tool-web`, confirmed against
// its installed `lib/index.js` — not guessed), Serper plugged in as its
// search provider (packages/tool/serper-web-search). 2026-09-15: every call
// merges into a `SearchSourcesPill` instead of a generic `ToolPill` — see
// `LogEntry`'s `"search"` variant.
export const WEB_SEARCH_TOOL = "web_search";

// The `skill` tool (@deepseek-ai/dsh-tool-skill) shows as "Đã đọc skill <name>"
// so the user sees which skill the model followed (2026-09-15: no longer hidden).
export const SKILL_TOOL = "skill";

// docs/data-studio-agent-transfer-plan.md — real name registered by
// packages/tool/data-studio-agent/src/index.ts's `defineTool`.
export const ANALYZE_DATA_TOOL = "analyze_data";

// Real shape of `tool/result`'s `event.data.meta` for a `web_search` call —
// `dsh-tools`' own `presentationMeta()` output, confirmed against its
// installed source while researching this feature. Narrowed here rather
// than trusted blindly: `meta` is `unknown` on the wire (`wire.ts`'s
// `SessionEvent.data` is deliberately untyped), and a malformed/absent
// shape must fall back to "0 sources found," never throw.
export function parseWebSearchMeta(
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

// Real shape of `analyze_data`'s `presentationMeta` output
// (packages/tool/data-studio-agent/src/index.ts) — same "narrow, never
// trust the wire" treatment as `parseWebSearchMeta` above.
export interface DataStudioMeta {
  sql: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  chart: ChartSpec | null;
  // docs/data-studio-admin-ui-plan.md phase 5 — the real `charts` document id
  // (uuid string, bridge/runner.py's `_persist_chart`), when `chart` is present. Lets
  // DataStudioResultPill offer "pin to dashboard".
  chartId: string | null;
  // Every visual chart (recommended first), each with its own rows + persisted chart_id, plus the
  // pipeline's follow-up suggestions and assumptions — rendered by DataStudioAnswer.
  charts: ChartSpec[];
  followUps: string[];
  assumptions: string[];
  truncated: boolean;
}

export function parseDataStudioMeta(meta: unknown): DataStudioMeta | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const record = meta as Record<string, unknown>;
  if (!Array.isArray(record.rows) || !Array.isArray(record.columns)) return undefined;
  const chart =
    typeof record.chart === "object" && record.chart !== null
      ? (record.chart as ChartSpec)
      : null;
  return {
    sql: typeof record.sql === "string" ? record.sql : null,
    columns: record.columns.filter((c): c is string => typeof c === "string"),
    rows: record.rows.filter(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
    ),
    rowCount: typeof record.rowCount === "number" ? record.rowCount : 0,
    chart,
    chartId: typeof record.chartId === "string" ? record.chartId : null,
    charts: Array.isArray(record.charts)
      ? record.charts
          .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
          .map((c) => c as ChartSpec)
      : chart
        ? [chart]
        : [],
    followUps: strings(record.followUps),
    assumptions: strings(record.assumptions),
    truncated: record.truncated === true,
  };
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

// ---- Declarative log state.

// docs/code-rules.md convention this file already follows: real fields,
// confirmed against installed .d.ts, not guessed.
export interface WebSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

export type LogEntry =
  | { kind: "notice"; id: string; text: string; muted?: boolean }
  | {
      kind: "tool";
      id: string;
      turn: number;
      name: string;
      args: string;
      status: "running" | "done" | "error";
      resultText: string | null;
      // Set for the `skill` tool and `/name` invocations: the skill's name.
      skill?: string;
    }  // 2026-09-15 (user: "UI dùng tool đang ghi là dùng web_search... ghi là
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
      // The user pressed Stop while this search ran.
      stopped?: boolean;
      sources: WebSource[];
      truncated: boolean;
      answer?: string;
    }
  // docs/data-studio-agent-transfer-plan.md: one pill per `analyze_data`
  // call (not merged across calls like "search" above — this tool is slow
  // and deliberately called once per distinct question, so there's no
  // "several calls in flight" case worth collapsing).
  | {
      kind: "data-studio";
      id: string;
      turn: number;
      status: "running" | "done" | "error";
      // epoch ms when the tool/call fired — lets the pill tick a live elapsed
      // timer while `status === "running"` (a real call routinely takes
      // several minutes; without this the pill looks frozen the whole time).
      startedAt: number;
      question: string;
      answer?: string;
      errorText?: string;
      sql: string | null;
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
      chart: ChartSpec | null;
      chartId: string | null;
      charts: ChartSpec[];
      assumptions: string[];
      followUps: string[];
      truncated: boolean;
      // the steps of the run so far (`fox/data-studio-progress` events), shown live — see DataStudioProgress.tsx
      progress: ProgressItem[];
    }
  | { kind: "bubble"; id: string; role: "user" | "assistant"; text: string }
  // a canvas_write result: a chip that opens the side panel (components/features/canvas)
  | ({ kind: "canvas"; id: string } & CanvasChipEntry)
  // the files a finished turn wrote (TurnFiles.tsx); renders nothing when it wrote none
  | ({ kind: "turn-files"; id: string } & TurnFilesEntry);

export interface LiveBubble {
  text: string;
}

export function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

export function contentToText(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
export function buildBubbleEntry(
  id: string,
  role: "user" | "assistant",
  content: ContentBlock[],
): LogEntry | undefined {
  const text = contentToText(content).trim();
  if (!text) return undefined;
  return { kind: "bubble", id, role, text };
}

// Builds a markdown table so the row data can reuse Markdown.tsx's existing
// GFM table styling/scroll wrapper instead of a bespoke `<table>`.
export function rowsToMarkdownTable(columns: string[], rows: Record<string, unknown>[]): string {
  const escapeCell = (value: unknown): string =>
    String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const header = `| ${columns.map(escapeCell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((c) => escapeCell(row[c])).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

// Data Studio (2026-10-19): the result card already shows the pipeline's answer, and the model then often wrote
// the same answer again under it (session 7ba2a86e: the same four counts twice). The persona tells it not to;
// this hides a reply that still does — most of its numbers are the card's — so the pipeline's answer, the one
// the chart and SQL come from, is the only one shown. A reply with something new (a caveat, no numbers) stays.
export function numbersOf(text: string): string[] {
  return (text.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/[.,]+$/, "").replace(/[.,]/g, ""));
}
export function restatesAnswer(reply: string, answer: string): boolean {
  const said = numbersOf(reply);
  if (said.length < 2) return false;
  const known = new Set(numbersOf(answer));
  return said.filter((n) => known.has(n)).length / said.length >= 0.6;
}
export function withoutRestatedAnswers(entries: LogEntry[]): LogEntry[] {
  let answer: string | undefined;
  return entries.filter((entry) => {
    if (entry.kind === "bubble" && entry.role === "user") answer = undefined;
    if (entry.kind === "data-studio") answer = entry.answer ?? answer;
    if (entry.kind === "bubble" && entry.role === "assistant" && answer !== undefined) return !restatesAnswer(entry.text, answer);
    return true;
  });
}
