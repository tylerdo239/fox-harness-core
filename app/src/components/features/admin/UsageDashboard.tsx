// The admin usage dashboard at /admin/usage (docs/admin-usage-dashboard-plan.md §6; modelled on
// examples/pynote-fe's reports.tsx). Numbers only — the gateway never stores message text. Refreshes every minute
// while the tab is visible; a new period keeps the previous numbers on screen, dimmed, until it arrives.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
import { ArrowLeftIcon, CloseIcon, DownloadIcon, UsageIcon } from "../../../icons.tsx";
import { useRuntime } from "../../../runtime.ts";
import { getUsageReport, getUserUsage, type Group, type Period, type Totals, type UsageReport, type UserUsage } from "./usageApi.ts";

type T = (key: TranslationKey, params?: Record<string, string>) => string;

const REFRESH_MS = 60_000;
const UTC_OFFSET_MS = 7 * 3_600_000;

/** Today in the report's days (Asia/Ho_Chi_Minh): the gateway counts days at +07:00. */
function today(): string {
  return new Date(Date.now() + UTC_OFFSET_MS).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

type Preset = "7" | "30" | "90" | "month" | "lastMonth" | "custom";

function presetPeriod(preset: Exclude<Preset, "custom">, group: Group): Period {
  const to = today();
  if (preset === "month") return { from: `${to.slice(0, 7)}-01`, to, group };
  if (preset === "lastMonth") {
    const firstThis = `${to.slice(0, 7)}-01`;
    const lastPrev = addDays(firstThis, -1);
    return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev, group };
  }
  return { from: addDays(to, -(Number(preset) - 1)), to, group };
}

function useFormat() {
  const { locale } = useLocale();
  const tag = locale === "en" ? "en-US" : "vi-VN";
  return useMemo(() => {
    const number = new Intl.NumberFormat(tag);
    const compact = new Intl.NumberFormat(tag, { notation: "compact", maximumFractionDigits: 1 });
    const percent = new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 1 });
    const date = new Intl.DateTimeFormat(tag, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" });
    const dateTime = new Intl.DateTimeFormat(tag, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });
    return {
      n: (v: number) => number.format(v),
      c: (v: number) => compact.format(v),
      pct: (v: number) => percent.format(v),
      ms: (v: number | null) => (v === null ? "—" : v < 1000 ? `${String(v)} ms` : v < 60_000 ? `${(v / 1000).toFixed(1)} s` : `${(v / 60_000).toFixed(1)} min`),
      day: (iso: string) => date.format(new Date(`${iso}T00:00:00+07:00`)),
      at: (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : "—"),
    };
  }, [tag]);
}

function successRate(t: Totals): number | null {
  const counted = t.turns - t.cancelledTurns;
  return counted > 0 ? t.completedTurns / counted : null;
}

function Delta({ now, before, lowerIsBetter = false }: { now: number | null; before: number | null; lowerIsBetter?: boolean }) {
  if (now === null || before === null || before === 0) return null;
  const change = (now - before) / before;
  if (Math.abs(change) < 0.005) return <span className="fh-usage-delta">±0%</span>;
  const good = lowerIsBetter ? change < 0 : change > 0;
  return (
    <span className={`fh-usage-delta ${good ? "fh-usage-delta-good" : "fh-usage-delta-bad"}`}>
      {change > 0 ? "▲" : "▼"} {Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%
    </span>
  );
}

function Kpi({ label, value, hint, delta }: { label: string; value: string; hint?: string; delta?: ReactNode }) {
  return (
    <div className="fh-usage-kpi">
      <div className="fh-usage-kpi-label">{label}</div>
      <div className="fh-usage-kpi-value">{value}</div>
      <div className="fh-usage-kpi-foot">
        {delta}
        {hint && <span className="fh-usage-kpi-hint">{hint}</span>}
      </div>
    </div>
  );
}

function Panel({ title, children, actions, wide }: { title: string; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  return (
    <section className={`fh-usage-panel${wide ? " fh-usage-panel-wide" : ""}`}>
      <header className="fh-usage-panel-head">
        <h3>{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  );
}

const AXIS = { fontSize: 11, fill: "var(--muted)" };
const tooltipStyle = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--fg)" };

function SeriesChart({ data, bars, line, format }: {
  data: Record<string, number | string>[];
  bars?: { key: string; name: string; color: string; stack?: string }[];
  line?: { key: string; name: string };
  format: (v: number) => string;
}) {
  return (
    <div className="fh-usage-chart">
      <ResponsiveContainer width="100%" height={200}>
        {line ? (
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => format(v)} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => format(Number(v))} />
            <Line type="monotone" dataKey={line.key} name={line.name} stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        ) : (
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => format(v)} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--bg-hover)" }} formatter={(v) => format(Number(v))} />
            {(bars ?? []).map((b, i) => (
              <Bar key={b.key} dataKey={b.key} name={b.name} fill={b.color} stackId={b.stack} radius={i === (bars ?? []).length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={36} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function Ranked({ rows, empty }: { rows: { label: string; hint?: string; value: number; shown: string; tone?: "danger" }[]; empty: string }) {
  if (rows.length === 0) return <p className="fh-usage-empty">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="fh-usage-ranked">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="fh-usage-ranked-label" title={r.hint ?? r.label}>
            <span>{r.label}</span>
            <b className={r.tone === "danger" ? "fh-usage-danger" : undefined}>{r.shown}</b>
          </div>
          <div className="fh-usage-bar"><span style={{ width: r.value > 0 ? `${Math.max(2, (r.value / max) * 100)}%` : 0 }} /></div>
        </li>
      ))}
    </ul>
  );
}

function download(name: string, rows: (string | number)[][]): void {
  const csv = rows.map((row) => row.map((cell) => {
    const text = String(cell);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type SortKey = "tokens" | "turns" | "chats" | "toolCalls" | "toolErrors" | "avgTurnMs" | "lastActiveAt";

function UsersTable({ report, onOpen, t }: { report: UsageReport; onOpen: (id: number) => void; t: T }) {
  const f = useFormat();
  const [sort, setSort] = useState<SortKey>("tokens");
  const value = (u: UsageReport["users"][number]): number | string =>
    sort === "tokens" ? u.inputTokens + u.outputTokens : sort === "lastActiveAt" ? u.lastActiveAt ?? "" : (u[sort] ?? -1);
  const rows = [...report.users].sort((a, b) => (value(a) < value(b) ? 1 : value(a) > value(b) ? -1 : 0));
  const maxTokens = Math.max(1, ...report.users.map((u) => u.inputTokens + u.outputTokens));
  const head = (key: SortKey, label: string) => (
    <th>
      <button type="button" className={`fh-usage-sort${sort === key ? " fh-usage-sort-on" : ""}`} onClick={() => setSort(key)}>{label}{sort === key ? " ↓" : ""}</button>
    </th>
  );
  if (rows.length === 0) return <p className="fh-usage-empty">{t("usage.empty")}</p>;
  return (
    <div className="fh-usage-table-wrap">
      <table className="fh-usage-table">
        <thead>
          <tr>
            <th>{t("usage.col.user")}</th>
            {head("chats", t("usage.col.chats"))}
            {head("turns", t("usage.col.turns"))}
            {head("tokens", t("usage.col.tokens"))}
            {head("toolCalls", t("usage.col.toolCalls"))}
            {head("toolErrors", t("usage.col.errors"))}
            {head("avgTurnMs", t("usage.col.avgTime"))}
            {head("lastActiveAt", t("usage.col.lastActive"))}
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => {
            const tokens = u.inputTokens + u.outputTokens;
            return (
              <tr key={u.id} onClick={() => onOpen(u.id)} className="fh-usage-row">
                <td>
                  <span className="fh-usage-user">
                    <span className="fh-usage-avatar">{(u.email ?? "?").charAt(0).toUpperCase()}</span>
                    <span className="fh-usage-user-email">{u.email ?? t("usage.unknownUser", { id: String(u.id) })}</span>
                    {u.role === "admin" && <span className="fh-usage-tag">admin</span>}
                  </span>
                </td>
                <td>{f.n(u.chats)}</td>
                <td>{f.n(u.turns)}</td>
                <td title={`${f.n(u.inputTokens)} in · ${f.n(u.outputTokens)} out`}>
                  <div className="fh-usage-cell-bar"><span style={{ width: `${Math.max(2, (tokens / maxTokens) * 100)}%` }} /></div>
                  {f.c(tokens)}
                </td>
                <td>{f.n(u.toolCalls)}</td>
                <td className={u.toolErrors > 0 ? "fh-usage-danger" : undefined}>{f.n(u.toolErrors)}</td>
                <td>{f.ms(u.avgTurnMs)}</td>
                <td>{f.at(u.lastActiveAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UserDrawer({ userId, period, onClose, t }: { userId: number; period: Period; onClose: () => void; t: T }) {
  const runtime = useRuntime();
  const f = useFormat();
  const [data, setData] = useState<UserUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    getUserUsage(runtime, userId, period).then((d) => live && setData(d), (e: unknown) => live && setError(String(e instanceof Error ? e.message : e)));
    return () => { live = false; };
  }, [runtime, userId, period]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const more = async () => {
    if (!data || data.next === null) return;
    setLoadingMore(true);
    try {
      const page = await getUserUsage(runtime, userId, period, data.next);
      setData({ ...page, chats: [...data.chats, ...page.chats] });
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <div className="fh-usage-drawer-backdrop" onClick={onClose}>
      <aside className="fh-usage-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("usage.userChats")}>
        <header>
          <div>
            <h3>{data?.user.email ?? t("usage.unknownUser", { id: String(userId) })}</h3>
            <p>{t("usage.userChatsHint", { from: f.day(period.from), to: f.day(period.to) })}</p>
          </div>
          <button type="button" className="fh-usage-icon-btn" onClick={onClose} aria-label={t("usage.close")}><CloseIcon size={18} /></button>
        </header>
        {error && <p className="fh-usage-error">{error}</p>}
        {!data && !error && <div className="fh-usage-skeleton" style={{ height: 240 }} />}
        {data && data.chats.length === 0 && <p className="fh-usage-empty">{t("usage.empty")}</p>}
        {data && data.chats.length > 0 && (
          <ul className="fh-usage-chats">
            {data.chats.map((chat) => (
              <li key={chat.sessionId}>
                <div className="fh-usage-chat-title">{chat.title || t("usage.untitled")}</div>
                <div className="fh-usage-chat-meta">
                  <span className="fh-usage-tag">{flowLabel(chat.flow, t)}</span>
                  <span>{t("usage.chatTurns", { n: f.n(chat.turns) })}</span>
                  <span>{f.c(chat.inputTokens + chat.outputTokens)} tokens</span>
                  <span>{t("usage.chatTools", { n: f.n(chat.toolCalls) })}</span>
                  <span>{f.at(chat.lastActiveAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {data?.next !== null && data?.next !== undefined && (
          <button type="button" className="fh-usage-more" disabled={loadingMore} onClick={() => void more()}>{t("usage.loadMore")}</button>
        )}
      </aside>
    </div>
  );
}

function flowLabel(flow: string, t: T): string {
  const key = ({ default: "usage.flow.default", "data-analysis": "usage.flow.dataAnalysis", "data-studio": "usage.flow.dataStudio", admin: "usage.flow.admin" } as Record<string, TranslationKey>)[flow];
  return key ? t(key) : flow;
}

function reasonLabel(kind: string, t: T): string {
  const key = ({ error: "usage.reason.error", "max-tokens": "usage.reason.maxTokens", interrupted: "usage.reason.interrupted", unknown: "usage.reason.unknown" } as Record<string, TranslationKey>)[kind];
  return key ? t(key) : kind;
}

function Skeleton() {
  return (
    <div role="status" className="fh-usage-skeleton-grid">
      {Array.from({ length: 8 }, (_, i) => <div key={i} className="fh-usage-skeleton" style={{ height: 96 }} />)}
      <div className="fh-usage-skeleton fh-usage-panel-wide" style={{ height: 240 }} />
      <div className="fh-usage-skeleton fh-usage-panel-wide" style={{ height: 240 }} />
    </div>
  );
}

export function UsageDashboard({ onBack }: { onBack: () => void }) {
  const runtime = useRuntime();
  const { t } = useLocale();
  const f = useFormat();
  const [preset, setPreset] = useState<Preset>("30");
  const [period, setPeriod] = useState<Period>(() => presetPeriod("30", "day"));
  const [draft, setDraft] = useState({ from: period.from, to: period.to });
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openUser, setOpenUser] = useState<number | null>(null);
  const request = useRef(0);

  const load = useCallback(async (p: Period) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const next = await getUsageReport(runtime, p);
      if (id === request.current) {
        setReport(next);
        setError(null);
      }
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    void load(period);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(period);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, period]);

  const choosePreset = (p: Preset) => {
    setPreset(p);
    if (p === "custom") return;
    const next = presetPeriod(p, period.group);
    setDraft({ from: next.from, to: next.to });
    setPeriod(next);
  };
  const rangeError = draft.from > draft.to ? t("usage.rangeOrder") : (Date.parse(draft.to) - Date.parse(draft.from)) / 86_400_000 + 1 > 366 ? t("usage.rangeMax") : null;
  const applyCustom = () => {
    if (rangeError || !draft.from || !draft.to) return;
    setPreset("custom");
    setPeriod({ from: draft.from, to: draft.to, group: period.group });
  };

  const seriesData = useMemo(() => (report?.series ?? []).map((s) => ({
    label: report?.range.group === "month" ? s.key : f.day(s.from).slice(0, 5),
    input: s.inputTokens,
    output: s.outputTokens,
    turns: s.turns,
    users: s.activeUsers,
    avg: s.avgTurnMs ?? 0,
  })), [report, f]);

  const totals = report?.totals;
  const previous = report?.previous;
  const weekdayNames = t("usage.weekdayNames").split(",");

  const exportUsers = () => {
    if (!report) return;
    download(`usage-users_${report.range.from}_${report.range.to}.csv`, [
      ["email", "role", "chats", "turns", "input_tokens", "output_tokens", "tool_calls", "tool_errors", "avg_turn_ms", "last_active"],
      ...report.users.map((u) => [u.email ?? `#${String(u.id)}`, u.role ?? "", u.chats, u.turns, u.inputTokens, u.outputTokens, u.toolCalls, u.toolErrors, u.avgTurnMs ?? "", u.lastActiveAt ?? ""]),
    ]);
  };
  const exportSeries = () => {
    if (!report) return;
    download(`usage_${report.range.from}_${report.range.to}_${report.range.group}.csv`, [
      ["period", "from", "to", "active_users", "chats", "turns", "completed", "failed", "input_tokens", "output_tokens", "cache_read_tokens", "tool_calls", "tool_errors", "avg_turn_ms"],
      ...report.series.map((s) => [s.key, s.from, s.to, s.activeUsers, s.chats, s.turns, s.completedTurns, s.failedTurns, s.inputTokens, s.outputTokens, s.cacheReadTokens, s.toolCalls, s.toolErrors, s.avgTurnMs ?? ""]),
    ]);
  };

  return (
    <div className="fh-usage">
      <div className="fh-usage-scroll">
        <header className="fh-usage-head">
          <button type="button" className="fh-usage-icon-btn" onClick={onBack} aria-label={t("usage.back")} title={t("usage.back")}><ArrowLeftIcon size={18} /></button>
          <span className="fh-usage-head-icon"><UsageIcon size={20} /></span>
          <div className="fh-usage-head-text">
            <h1>{t("usage.title")}</h1>
            <p>{t("usage.subtitle")}</p>
          </div>
        </header>

        <div className="fh-usage-filter">
          <div className="fh-usage-presets" role="radiogroup" aria-label={t("usage.period")}>
            {(["7", "30", "90", "month", "lastMonth"] as const).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={preset === p} className={`fh-usage-chip${preset === p ? " fh-usage-chip-on" : ""}`} onClick={() => choosePreset(p)}>
                {p === "month" ? t("usage.thisMonth") : p === "lastMonth" ? t("usage.lastMonth") : t("usage.lastDays", { n: p })}
              </button>
            ))}
          </div>
          <div className="fh-usage-custom">
            <label>{t("usage.from")}<input type="date" value={draft.from} max={today()} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
            <label>{t("usage.to")}<input type="date" value={draft.to} max={today()} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
            <button type="button" className="fh-usage-chip" disabled={!!rangeError} onClick={applyCustom}>{t("usage.apply")}</button>
            <select value={period.group} aria-label={t("usage.groupBy")} onChange={(e) => { const group = e.target.value as Group; setPeriod({ ...period, group }); }}>
              <option value="day">{t("usage.byDay")}</option>
              <option value="week">{t("usage.byWeek")}</option>
              <option value="month">{t("usage.byMonth")}</option>
            </select>
          </div>
          {rangeError && <p className="fh-usage-error">{rangeError}</p>}
        </div>

        {report && (
          <div className="fh-usage-range">
            <span>{t("usage.range", { from: f.day(report.range.from), to: f.day(report.range.to), prevFrom: f.day(report.range.previousFrom), prevTo: f.day(report.range.previousTo) })}</span>
            <button type="button" className="fh-usage-chip" onClick={exportSeries}><DownloadIcon size={14} />{t("usage.exportCsv")}</button>
          </div>
        )}
        {loading && report && <div className="fh-usage-progress" />}
        {error && !report && <p className="fh-usage-error fh-usage-error-big">{error}</p>}
        {error && report && <p className="fh-usage-error">{t("usage.refreshFailed", { error })}</p>}
        {!report && !error && <Skeleton />}

        {report && totals && previous && (
          <div className={`fh-usage-body${loading ? " fh-usage-body-dim" : ""}`}>
            {totals.turns === 0 && report.users.length === 0 && (
              <p className="fh-usage-empty fh-usage-empty-big">{report.since ? t("usage.emptyPeriod") : t("usage.noDataYet")}</p>
            )}
            <div className="fh-usage-kpis">
              <Kpi label={t("usage.kpi.activeUsers")} value={f.n(totals.activeUsers)} delta={<Delta now={totals.activeUsers} before={previous.activeUsers} />} />
              <Kpi label={t("usage.kpi.chats")} value={f.n(totals.chats)} delta={<Delta now={totals.chats} before={previous.chats} />} />
              <Kpi label={t("usage.kpi.turns")} value={f.n(totals.turns)} delta={<Delta now={totals.turns} before={previous.turns} />} />
              <Kpi
                label={t("usage.kpi.tokens")}
                value={f.c(totals.inputTokens + totals.outputTokens)}
                hint={t("usage.kpi.tokensHint", { in: f.c(totals.inputTokens), out: f.c(totals.outputTokens), cache: f.c(totals.cacheReadTokens) })}
                delta={<Delta now={totals.inputTokens + totals.outputTokens} before={previous.inputTokens + previous.outputTokens} />}
              />
              <Kpi label={t("usage.kpi.avgTime")} value={f.ms(totals.avgTurnMs)} hint={t("usage.kpi.median", { v: f.ms(totals.medianTurnMs) })} delta={<Delta now={totals.avgTurnMs} before={previous.avgTurnMs} lowerIsBetter />} />
              <Kpi label={t("usage.kpi.success")} value={successRate(totals) === null ? "—" : f.pct(successRate(totals)!)} hint={t("usage.kpi.successHint", { failed: f.n(totals.failedTurns) })} delta={<Delta now={successRate(totals)} before={successRate(previous)} />} />
              <Kpi label={t("usage.kpi.toolCalls")} value={f.n(totals.toolCalls)} hint={t("usage.kpi.toolErrors", { n: f.n(totals.toolErrors) })} delta={<Delta now={totals.toolCalls} before={previous.toolCalls} />} />
              <Kpi label={t("usage.kpi.attachments")} value={f.n(totals.attachments)} delta={<Delta now={totals.attachments} before={previous.attachments} />} />
            </div>

            {totals.failedTurns > 0 && <p className="fh-usage-alert">{t("usage.failedAlert", { n: f.n(totals.failedTurns) })}</p>}

            <div className="fh-usage-grid">
              <Panel title={t("usage.chart.tokens")}>
                <SeriesChart data={seriesData} format={f.c} bars={[
                  { key: "input", name: t("usage.input"), color: "var(--accent)", stack: "t" },
                  { key: "output", name: t("usage.output"), color: "color-mix(in srgb, var(--accent) 45%, var(--bg))", stack: "t" },
                ]} />
              </Panel>
              <Panel title={t("usage.chart.turns")}>
                <SeriesChart data={seriesData} format={f.n} bars={[{ key: "turns", name: t("usage.kpi.turns"), color: "var(--accent)" }]} />
              </Panel>
              <Panel title={t("usage.chart.users")}>
                <SeriesChart data={seriesData} format={f.n} bars={[{ key: "users", name: t("usage.kpi.activeUsers"), color: "var(--accent)" }]} />
              </Panel>
              <Panel title={t("usage.chart.avgTime")}>
                <SeriesChart data={seriesData} format={(v) => f.ms(v)} line={{ key: "avg", name: t("usage.kpi.avgTime") }} />
              </Panel>
              <Panel title={t("usage.chart.hours")}>
                <SeriesChart data={report.hours.map((v, h) => ({ label: `${String(h)}h`, v }))} format={f.n} bars={[{ key: "v", name: t("usage.kpi.turns"), color: "var(--accent)" }]} />
              </Panel>
              <Panel title={t("usage.chart.weekdays")}>
                <SeriesChart data={report.weekdays.map((v, d) => ({ label: weekdayNames[d] ?? String(d), v }))} format={f.n} bars={[{ key: "v", name: t("usage.kpi.turns"), color: "var(--accent)" }]} />
              </Panel>

              <Panel title={t("usage.outcomes")}>
                <Ranked
                  empty={t("usage.empty")}
                  rows={[
                    { label: t("usage.outcome.completed"), value: report.outcomes.completed, shown: f.n(report.outcomes.completed) },
                    { label: t("usage.outcome.cancelled"), value: report.outcomes.cancelled, shown: f.n(report.outcomes.cancelled) },
                    { label: t("usage.outcome.failed"), value: report.outcomes.failed, shown: f.n(report.outcomes.failed), tone: "danger" as const },
                    { label: t("usage.outcome.blocked"), value: report.outcomes.blocked, shown: f.n(report.outcomes.blocked) },
                  ].filter((r) => totals.turns > 0 || r.value > 0)}
                />
                {report.outcomes.kinds.length > 0 && (
                  <div className="fh-usage-kinds">
                    {report.outcomes.kinds.map((k) => <span key={k.kind} className="fh-usage-tag">{reasonLabel(k.kind, t)} · {f.n(k.count)}</span>)}
                  </div>
                )}
              </Panel>
              <Panel title={t("usage.byFlow")}>
                <Ranked
                  empty={t("usage.empty")}
                  rows={report.flows.map((fl) => ({ label: flowLabel(fl.flow, t), value: fl.inputTokens + fl.outputTokens, shown: `${f.c(fl.inputTokens + fl.outputTokens)} · ${t("usage.chatTurns", { n: f.n(fl.turns) })}` }))}
                />
              </Panel>
              <Panel title={t("usage.byModel")}>
                <Ranked
                  empty={t("usage.empty")}
                  rows={report.models.map((m) => ({ label: m.model, value: m.input + m.output, shown: `${f.c(m.input + m.output)} · ${t("usage.calls", { n: f.n(m.calls) })}` }))}
                />
              </Panel>
              <Panel title={t("usage.topTools")}>
                <Ranked
                  empty={t("usage.empty")}
                  rows={report.tools.map((tool) => ({
                    label: tool.tool,
                    value: tool.calls,
                    shown: tool.errors > 0 ? `${f.n(tool.calls)} · ${t("usage.errorRate", { v: f.pct(tool.errors / Math.max(1, tool.calls)) })}` : f.n(tool.calls),
                    // red from a 5% error rate: a stray failure is not a problem tool
                    ...(tool.errors / Math.max(1, tool.calls) >= 0.05 ? { tone: "danger" as const } : {}),
                  }))}
                />
              </Panel>

              <Panel title={t("usage.dataStudio")}>
                <div className="fh-usage-tiles">
                  <div><b>{f.n(report.dataStudio.turns)}</b><span>{t("usage.ds.questions")}</span></div>
                  <div><b>{f.c(report.dataStudio.inputTokens + report.dataStudio.outputTokens)}</b><span>{t("usage.ds.pipeline")}</span></div>
                  <div><b>{f.c(report.dataStudio.embeddingTokens)}</b><span>{t("usage.ds.embedding")}</span></div>
                  <div><b>{f.c(report.dataStudio.profileTokens)}</b><span>{t("usage.ds.profile")}</span></div>
                </div>
              </Panel>
              <Panel title={t("usage.overhead")}>
                <div className="fh-usage-tiles">
                  <div><b>{f.c(report.overhead.compactionTokens)}</b><span>{t("usage.oh.compaction")}</span></div>
                  <div><b>{f.n(report.overhead.failedCalls)}</b><span>{t("usage.oh.failed")}</span></div>
                  <div><b>{report.overhead.cacheShare === null ? "—" : f.pct(report.overhead.cacheShare)}</b><span>{t("usage.oh.cache")}</span></div>
                  <div><b>{f.n(report.overhead.estimatedCalls)}</b><span>{t("usage.oh.estimated")}</span></div>
                </div>
              </Panel>

              <Panel
                wide
                title={t("usage.byUser")}
                actions={<button type="button" className="fh-usage-chip" onClick={exportUsers} disabled={report.users.length === 0}><DownloadIcon size={14} />{t("usage.exportCsv")}</button>}
              >
                <UsersTable report={report} onOpen={setOpenUser} t={t} />
              </Panel>
            </div>
            <p className="fh-usage-foot">{t("usage.privacy")}{report.since ? ` ${t("usage.since", { at: f.at(report.since) })}` : ""}</p>
          </div>
        )}
      </div>
      {openUser !== null && <UserDrawer userId={openUser} period={period} onClose={() => setOpenUser(null)} t={t} />}
    </div>
  );
}
