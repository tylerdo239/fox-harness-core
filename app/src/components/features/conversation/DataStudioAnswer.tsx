// The reply of an `analyze_data` call in the Data Studio chat (docs/data-studio-agent-transfer-plan.md),
// rendered INLINE like a normal assistant message instead of inside a collapsed tool pill. Layout follows
// examples/example-data-studio-agent's chat (V2ResultView): answer prose first, a "Xem SQL" toggle, the
// active chart with a "recommended visualizations" switcher (plus the raw data table), row count,
// assumptions, and clickable follow-up suggestions. The default chat keeps its pill (Conversation.tsx).
import { useEffect, useMemo, useState } from "react";
import { format } from "sql-formatter";
import { toast } from "sonner";

import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
import {
  ChartBarIcon,
  ChartLineIcon,
  ChartPieIcon,
  ChartScatterIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  DashboardsIcon,
  GearIcon,
  LightbulbIcon,
  PinIcon,
  SuggestionIcon,
  TableIcon,
} from "../../../icons.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { dsApi, type ChartUpdate } from "../data-studio/dsApi.ts";
import { AddToDashboardDialog, EditColorsDialog, EditFieldsDialog } from "./ChartDialogs.tsx";
import { ChartView, EDITABLE_CHART_TYPES, resolveChart, type ChartSpec } from "./ChartView.tsx";
import { DataStudioProgress, type ProgressItem } from "./DataStudioProgress.tsx";
import { Markdown } from "./Markdown.tsx";

type T = (key: TranslationKey, params?: Record<string, string>) => string;

export interface DataStudioAnswerData {
  status: "running" | "done" | "error";
  // epoch ms when the tool call fired — drives the elapsed timer while running (a real call routinely
  // takes minutes; without it the line looks frozen).
  startedAt: number;
  answer?: string;
  errorText?: string;
  sql: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  charts: ChartSpec[];
  assumptions: string[];
  followUps: string[];
  truncated: boolean;
  progress: ProgressItem[];
}

// "Ghim vào dashboard" for an already-persisted chart (the `charts` document `chartId` references, created by
// bridge/runner.py). Opens the same "Thêm vào dashboard" dialog as the Data Studio chat.
// Any user: the chart and the dashboards are the user's own (docs/data-studio-user-dashboards-plan.md).
export function PinToDashboardButton({ chartId, t }: { chartId: string; t: T }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <PinIcon size={13} /> {t("conversation.pinToDashboard")}
      </Button>
      <AddToDashboardDialog open={open} onClose={() => setOpen(false)} chartId={chartId} />
    </>
  );
}

const CHART_ICON: Record<string, typeof ChartBarIcon> = {
  bar: ChartBarIcon,
  bar_horizontal: ChartBarIcon,
  stacked_bar: ChartBarIcon,
  combo: ChartBarIcon,
  line: ChartLineIcon,
  area: ChartLineIcon,
  stacked_area: ChartLineIcon,
  pie: ChartPieIcon,
  donut: ChartPieIcon,
  treemap: ChartPieIcon,
  scatter: ChartScatterIcon,
  table: TableIcon,
  stat: TableIcon,
};

function chartLabel(type: string | undefined, t: T): string {
  switch ((type ?? "bar").toLowerCase()) {
    case "line":
    case "area":
      return t("conversation.dsChartLine");
    case "stacked_area":
      return t("conversation.dsChartStackedArea");
    case "bar_horizontal":
      return t("conversation.dsChartBarHorizontal");
    case "stacked_bar":
      return t("conversation.dsChartStackedBar");
    case "combo":
      return t("conversation.dsChartCombo");
    case "pie":
      return t("conversation.dsChartPie");
    case "donut":
      return t("conversation.dsChartDonut");
    case "treemap":
      return t("conversation.dsChartTreemap");
    case "scatter":
      return t("conversation.dsChartScatter");
    case "table":
      return t("conversation.dsTable");
    case "stat":
      return t("conversation.dsStat");
    default:
      return t("conversation.dsChartBar");
  }
}

function formatCell(value: unknown, locale: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString(locale) : String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function prettySql(sql: string): string {
  try {
    // Dremio speaks Trino/Presto-style SQL. The pipeline emits one long line; keep it readable.
    return format(sql, { language: "trino", keywordCase: "upper" });
  } catch {
    return sql; // unparseable dialect fragment — show it as-is
  }
}

const TABLE_ROW_LIMIT = 100;

function DataTable({ columns, rows, locale }: { columns: string[]; rows: Record<string, unknown>[]; locale: string }) {
  const cols = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});
  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, TABLE_ROW_LIMIT).map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} title={typeof row[c] === "string" ? (row[c] as string) : undefined}>
                  {formatCell(row[c], locale)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DataStudioAnswer({
  entry,
  onFollowUp,
  t,
}: {
  entry: DataStudioAnswerData;
  onFollowUp: (question: string) => void;
  t: T;
}) {
  const { locale } = useLocale();
  const [showSql, setShowSql] = useState(false);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<null | "fields" | "colors" | "dashboard">(null);
  const runtime = useRuntime();
  // The chart toolbar (edit fields / colors -> PATCH /data-studio/charts/:id, add to dashboard): the chart is the
  // asker's own, so every user gets it (docs/data-studio-user-dashboards-plan.md).
  const sql = useMemo(() => (entry.sql ? prettySql(entry.sql) : ""), [entry.sql]);

  // Working copy of the charts so toolbar edits (fields / colors / labels) repaint immediately; each edit is
  // also persisted with PATCH /data-studio/charts/:id when the chart has been saved (has a chart_id).
  // Charts the pipeline could not give a plottable x / y / rows for (a single scalar such as "77 workflows"
  // comes back with y = []) are dropped instead of rendering an empty frame. Recommended first, tables last.
  const plottable = (c: ChartSpec) => {
    const type = (c.type ?? "bar").toLowerCase();
    if ((c.rows?.length ?? 0) === 0) return false;
    return type === "table" || type === "stat" || (!!c.x && (c.y?.length ?? 0) > 0);
  };
  const order = (list: ChartSpec[]) =>
    list
      .filter(plottable)
      .sort((a, b) => Number(a.type === "table") - Number(b.type === "table") || Number(!!b.recommended) - Number(!!a.recommended));
  const [specs, setSpecs] = useState<ChartSpec[]>(() => order([...entry.charts]));
  useEffect(() => setSpecs(order([...entry.charts])), [entry.charts]); // eslint-disable-line react-hooks/exhaustive-deps

  // The pipeline gave no table chart (e.g. nothing to persist): still offer the raw result as a view.
  const hasTableChart = specs.some((c) => c.type === "table");
  const syntheticTable = !hasTableChart && entry.rows.length > 0;
  const viewCount = specs.length + (syntheticTable ? 1 : 0);
  const current = Math.min(active, Math.max(viewCount - 1, 0));
  const activeChart = current < specs.length ? specs[current] : undefined;
  const activeResolved = activeChart ? resolveChart(activeChart) : undefined;
  const editableFields = activeResolved && EDITABLE_CHART_TYPES.includes((activeResolved.type ?? "").toLowerCase());
  const colorFields = activeResolved && (activeResolved.type ?? "").toLowerCase() !== "table" ? (activeResolved.y ?? []) : [];

  function updateActive(patch: Partial<ChartSpec>, persisted: ChartUpdate): void {
    const id = activeChart?.chart_id;
    setSpecs((prev) => prev.map((c, i) => (i === current ? { ...c, ...patch } : c)));
    if (id) void dsApi.updateChart(runtime, id, persisted).catch(() => toast.error(t("dsx.saveFailed")));
  }

  if (entry.status === "running") {
    // the chat's own "running a tool…" line is the indicator; here only the live steps
    return (
      <div className="ds-answer">
        <DataStudioProgress items={entry.progress} live t={t} />
      </div>
    );
  }

  if (entry.status === "error") {
    return (
      <div className="ds-answer">
        <div className="ds-error">
          <strong>{t("conversation.dataStudioFailed")}</strong>
          {entry.errorText && <div>{entry.errorText}</div>}
        </div>
        <DataStudioProgress items={entry.progress} live={false} t={t} />
      </div>
    );
  }

  return (
    <div className="ds-answer">
      <DataStudioProgress items={entry.progress} live={false} t={t} />
      {entry.answer && (
        <div className="assistant-text-body">
          <Markdown text={entry.answer} />
        </div>
      )}

      {sql && (
        <div className="ds-sql">
          <button type="button" className="ds-sql-toggle" onClick={() => setShowSql((v) => !v)} aria-expanded={showSql}>
            {showSql ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
            <CodeIcon size={13} />
            {t("conversation.dsViewSql")}
          </button>
          {showSql && <Markdown text={`\`\`\`sql\n${sql}\n\`\`\``} />}
        </div>
      )}

      {viewCount > 0 && (
        <div className="ds-visual">
          {activeChart ? (
            <ChartView chart={activeChart} height={320} />
          ) : (
            <DataTable columns={entry.columns} rows={entry.rows} locale={locale} />
          )}

          <div className="ds-views">
            <div className="ds-views-head">
              <div className="ds-section-label">{t("conversation.dsVisualizations")}</div>
              <div className="ds-toolbar">
                {activeChart?.chart_id && (
                  <Button variant="outline" onClick={() => setEditing("dashboard")}>
                    <DashboardsIcon size={13} /> {t("dsx.addToDashboard")}
                  </Button>
                )}
                <Button variant="outline" disabled={!editableFields} onClick={() => setEditing("fields")}>
                  <GearIcon size={13} /> {t("dsx.editFields")}
                </Button>
                <Button variant="outline" disabled={colorFields.length === 0} onClick={() => setEditing("colors")}>
                  <span className="ds-swatch" aria-hidden /> {t("dsx.editColors")}
                </Button>
              </div>
            </div>
            {viewCount > 1 && (
              <div className="ds-view-cards">
                {specs.map((chart, i) => {
                  const Icon = CHART_ICON[(chart.type ?? "bar").toLowerCase()] ?? ChartBarIcon;
                  return (
                    <button
                      key={`${chart.type}-${i}`}
                      type="button"
                      className={`ds-view-card${i === current ? " active" : ""}`}
                      onClick={() => setActive(i)}
                    >
                      <Icon size={16} />
                      <span className="ds-view-card-title">{chartLabel(chart.type, t)}</span>
                      {chart.title && chart.type !== "table" && <span className="ds-view-card-desc">{resolveChart(chart).title}</span>}
                    </button>
                  );
                })}
                {syntheticTable && (
                  <button
                    type="button"
                    className={`ds-view-card${current === specs.length ? " active" : ""}`}
                    onClick={() => setActive(specs.length)}
                  >
                    <TableIcon size={16} />
                    <span className="ds-view-card-title">{t("conversation.dsTable")}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="ds-meta">
            <span>{(entry.rowCount || entry.rows.length) === 1 ? t("conversation.dsRow") : t("conversation.dsRows", { n: String(entry.rowCount || entry.rows.length) })}</span>
            {entry.truncated && <span>· {t("conversation.dataStudioTruncated", { n: String(entry.rows.length) })}</span>}
          </div>
        </div>
      )}

      {activeChart && (
        <>
          <EditFieldsDialog
            open={editing === "fields"}
            onClose={() => setEditing(null)}
            spec={activeChart}
            onApply={(title, x, y, labelOverrides) =>
              updateActive(
                { title_override: title, x_override: x, y_override: y, label_overrides: labelOverrides },
                { title_override: title, x_override: x, y_override: y, label_overrides: labelOverrides },
              )
            }
          />
          <EditColorsDialog
            open={editing === "colors"}
            onClose={() => setEditing(null)}
            spec={activeChart}
            onApply={(colors) => updateActive({ color_overrides: colors }, { color_overrides: colors })}
          />
          {activeChart.chart_id && (
            <AddToDashboardDialog open={editing === "dashboard"} onClose={() => setEditing(null)} chartId={activeChart.chart_id} />
          )}
        </>
      )}

      {entry.assumptions.length > 0 && (
        <ul className="ds-assumptions">
          {entry.assumptions.map((assumption, i) => (
            <li key={i}>
              <LightbulbIcon size={13} />
              <span>{assumption}</span>
            </li>
          ))}
        </ul>
      )}

      {entry.followUps.length > 0 && (
        <div className="ds-suggestions">
          <div className="ds-section-label">{t("conversation.dsSuggestions")}</div>
          {entry.followUps.map((question, i) => (
            <button key={i} type="button" className="ds-suggestion" onClick={() => onFollowUp(question)}>
              <SuggestionIcon size={13} />
              <span>{question}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
