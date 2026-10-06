// The steps of a Data Studio question, live while it runs and folded away once it answered — our take on the
// reference web's run view (bot-data-studio-web-main components/chat-v4/run-view.tsx). The items come from
// `fox/data-studio-progress` session events (packages/tool/data-studio-agent: bridge/runner.py `_Progress` reduces
// pipeline v3 and v4 events to one small shape), so a reload or a reopened chat replays the same steps.
import { useMemo, useState } from "react";

import { ChevronDownIcon, ChevronRightIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";

type T = (key: TranslationKey, params?: Record<string, string>) => string;

export type ProgressItem = Record<string, unknown>;

type Status = "started" | "done" | "failed";

interface ToolRow {
  id: string;
  tool: string;
  args: string;
  result: string;
  status: Status;
}

interface AgentRow {
  id: string;
  agent: string;
  label: string;
  part: string;
  status: Status;
  error: string;
  tools: ToolRow[];
}

interface StepRow {
  name: string;
  label: string;
  status: Status;
}

interface RunView {
  steps: StepRow[];
  parts: { id: string; question: string }[];
  agents: AgentRow[];
  sqls: { sql: string; part: string; rows?: number }[];
  errors: string[];
}

// Names of the pipelines' steps and agents (v3 orchestrator, v4 agents) — data vocabulary, like ChartView's chart
// types; anything not listed shows the pipeline's own English label or name.
const NAMES: Record<string, { vi: string; en: string }> = {
  understand: { vi: "Hiểu câu hỏi", en: "Understanding the question" },
  find: { vi: "Tìm dữ liệu", en: "Finding the data" },
  plan: { vi: "Dựng truy vấn", en: "Building the query" },
  run: { vi: "Chạy truy vấn", en: "Running the query" },
  present: { vi: "Viết câu trả lời", en: "Writing the answer" },
  decompose: { vi: "Tách câu hỏi", en: "Splitting the question" },
  intake: { vi: "Hiểu câu hỏi", en: "Understanding the question" },
  rank: { vi: "Kiểm tra xếp hạng", en: "Checking for ranking" },
  clarify: { vi: "Kiểm tra độ rõ", en: "Checking clarity" },
  grain: { vi: "Xác định mức chi tiết", en: "Deciding the grain" },
  metric: { vi: "Chọn chỉ số đo", en: "Choosing what to measure" },
  filter: { vi: "Áp bộ lọc", en: "Applying filters" },
  slice: { vi: "Chọn cách chia nhóm", en: "Choosing the breakdown" },
  transform: { vi: "Tính giá trị dẫn xuất", en: "Computing derived values" },
  insight: { vi: "Viết câu trả lời", en: "Writing the answer" },
  chart: { vi: "Chọn biểu đồ", en: "Choosing a chart" },
  field: { vi: "Chọn trường biểu đồ", en: "Picking chart fields" },
  review: { vi: "Rà soát câu trả lời", en: "Reviewing the answer" },
  followups: { vi: "Gợi ý câu hỏi tiếp", en: "Suggesting follow-ups" },
  follow_ups: { vi: "Gợi ý câu hỏi tiếp", en: "Suggesting follow-ups" },
  scout: { vi: "Dò tìm dữ liệu", en: "Scouting the data" },
  keywords: { vi: "Trích từ khoá", en: "Picking key phrases" },
  tables: { vi: "Chọn bảng", en: "Choosing tables" },
  values: { vi: "Khớp giá trị", en: "Matching values" },
  kind: { vi: "Xác định loại câu hỏi", en: "Deciding the question kind" },
  measure: { vi: "Chọn phép đo", en: "Choosing the measure" },
  time: { vi: "Xác định thời gian", en: "Deciding the period" },
  condition: { vi: "Xác định điều kiện", en: "Deciding the conditions" },
  grouping: { vi: "Chọn cách nhóm", en: "Choosing the grouping" },
  answer: { vi: "Viết câu trả lời", en: "Writing the answer" },
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const status = (v: unknown): Status => (v === "done" || v === "failed" ? v : "started");

export function buildRunView(items: readonly ProgressItem[]): RunView {
  const view: RunView = { steps: [], parts: [], agents: [], sqls: [], errors: [] };
  const agents = new Map<string, AgentRow>();
  const tools = new Map<string, ToolRow>();
  const running = new Map<string, Set<string>>();
  for (const item of items) {
    switch (item.t) {
      case "step": {
        // find / plan / run run once per sub-question: a step is running while any of its parts is
        const name = str(item.name);
        let row = view.steps.find((s) => s.name === name);
        if (!row) {
          row = { name, label: str(item.label) || name, status: "started" };
          view.steps.push(row);
          running.set(name, new Set());
        }
        const parts = running.get(name)!;
        if (status(item.status) === "started") parts.add(str(item.part));
        else parts.delete(str(item.part));
        row.status = parts.size > 0 ? "started" : status(item.status);
        break;
      }
      case "parts":
        view.parts = (Array.isArray(item.parts) ? item.parts : []).map((p) => ({ id: str((p as ProgressItem).id), question: str((p as ProgressItem).question) }));
        break;
      case "agent": {
        const id = str(item.id);
        const row = agents.get(id);
        if (row) {
          row.status = status(item.status);
          row.error = str(item.error);
        } else {
          const created: AgentRow = { id, agent: str(item.agent), label: str(item.label), part: str(item.part), status: status(item.status), error: str(item.error), tools: [] };
          agents.set(id, created);
          view.agents.push(created);
        }
        break;
      }
      case "tool": {
        const id = str(item.id);
        const row = tools.get(id);
        if (row) {
          row.status = status(item.status);
          row.result = str(item.result);
          break;
        }
        const created: ToolRow = { id, tool: str(item.tool), args: str(item.args), result: str(item.result), status: status(item.status) };
        tools.set(id, created);
        agents.get(str(item.owner))?.tools.push(created);
        break;
      }
      case "sql":
        view.sqls.push({ sql: str(item.sql), part: str(item.part), ...(typeof item.rows === "number" ? { rows: item.rows } : {}) });
        break;
      case "result":
        if (item.status === "failed" && item.error) view.errors.push(str(item.error));
        break;
      case "error":
        view.errors.push(str(item.text));
        break;
    }
  }
  return view;
}

function Mark({ s }: { s: Status }) {
  if (s === "started") return <span className="ds-spinner ds-progress-mark" aria-hidden />;
  return <span className={`ds-progress-mark ds-progress-${s}`} aria-hidden>{s === "done" ? "✓" : "✗"}</span>;
}

function AgentLine({ row, name, live, t }: { row: AgentRow; name: string; live: boolean; t: T }) {
  const running = row.status === "started";
  const [open, setOpen] = useState(false);
  // while running: the agent's latest tool calls; afterwards they fold behind a click
  const shown = running && live ? row.tools.slice(-3) : open ? row.tools : [];
  return (
    <li className={`ds-progress-agent ds-progress-agent-${row.status}`}>
      <button type="button" className="ds-progress-row" onClick={() => setOpen((v) => !v)} disabled={row.tools.length === 0}>
        <Mark s={row.status} />
        <span className="ds-progress-label">{name}</span>
        {row.part && <span className="ds-progress-part">{row.part}</span>}
        {row.tools.length > 0 && (
          <span className="ds-progress-count">
            {t("conversation.dsProgressTools", { n: String(row.tools.length) })}
            {!running && (open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />)}
          </span>
        )}
      </button>
      {row.error && <div className="ds-progress-error">{row.error}</div>}
      {shown.length > 0 && (
        <ul className="ds-progress-tools">
          {shown.map((tool) => (
            <li key={tool.id} className="ds-progress-tool" title={tool.result || undefined}>
              <Mark s={tool.status} />
              <code>{tool.tool}</code>
              {tool.args && tool.args !== "{}" && <span className="ds-progress-args">{tool.args}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function DataStudioProgress({ items, live, t }: { items: readonly ProgressItem[]; live: boolean; t: T }) {
  const { locale } = useLocale();
  const view = useMemo(() => buildRunView(items), [items]);
  const [open, setOpen] = useState(false);
  const name = (key: string, fallback: string) => NAMES[key]?.[locale === "vi" ? "vi" : "en"] ?? (fallback || key);
  if (items.length === 0) return null;

  const body = (
    <div className="ds-progress-body">
      {view.steps.length > 0 && (
        <ol className="ds-progress-steps">
          {view.steps.map((s) => (
            <li key={s.name} className={`ds-progress-step ds-progress-step-${s.status}`}>
              <Mark s={s.status} />
              {name(s.name, s.label)}
            </li>
          ))}
        </ol>
      )}
      {view.parts.length > 1 && (
        <ul className="ds-progress-parts">
          {view.parts.map((p) => (
            <li key={p.id}>
              <span className="ds-progress-part">{p.id}</span> {p.question}
            </li>
          ))}
        </ul>
      )}
      <ul className="ds-progress-agents">
        {view.agents.map((row) => (
          <AgentLine key={row.id} row={row} name={name(row.agent, row.label)} live={live} t={t} />
        ))}
      </ul>
      {view.errors.map((e, i) => (
        <div key={i} className="ds-progress-error">
          {e}
        </div>
      ))}
    </div>
  );

  if (live) return <div className="ds-progress ds-progress-live">{body}</div>;
  const done = view.agents.filter((a) => a.status !== "started").length;
  return (
    <div className="ds-progress">
      <button type="button" className="ds-progress-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
        {t("conversation.dsProgressSteps", { n: String(done) })}
      </button>
      {open && body}
    </div>
  );
}
