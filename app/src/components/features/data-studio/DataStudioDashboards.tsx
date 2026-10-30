// Dashboards section of Data Studio — a port of the reference UI's three dashboard pages
// (examples/example-data-studio-agent: dashboards/page.tsx list, [id]/page.tsx report, [id]/edit/page.tsx builder)
// onto this app's shell and the gateway's dashboard API (dsApi.ts):
//   * list    — cards with widget count / last update, "Dashboard mới", delete.
//   * report  — themed header + 12-column widget grid (theme / density / card style from `appearance`),
//               "Lưu PDF" (browser print of the report), "Chỉnh sửa".
//   * builder — charts saved from conversations (left), drag / resize canvas (center), layout / density / theme /
//               card style / header panel (right), "Xem trước" and "Xuất bản" (bulk save).
// Role `user` gets the list and the report read-only (services/gateway only lets them GET dashboards): no create,
// delete or edit, and never the builder.
// State lives in this component (no URL routes), like the project hub.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";

import { ArrowLeftIcon, ChartBarIcon, CheckIcon, DashboardsIcon, PlusIcon, TrashIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";
import { ChartView, chartTitle } from "../conversation/ChartView.tsx";
import { DashboardHeader } from "./DashboardHeader.tsx";
import {
  chartOutToSpec,
  dsApi,
  type AvailableChart,
  type DashboardDetail,
  type DashboardSummary,
  type WidgetOut,
} from "./dsApi.ts";

type T = (key: TranslationKey, params?: Record<string, string>) => string;

const COLS = 12;
const ROW_H = 70; // px per grid row
const GAP = 14;

// theme palette — the report and the builder preview share it (the reference UI mirrors its PDF renderer's)
const THEMES: Record<string, { bg: string; surface: string; ink: string; ink3: string; border: string; swatch: string }> = {
  light: { bg: "#FFFFFF", surface: "#FFFFFF", ink: "#0E0E10", ink3: "#5A5A60", border: "#E6E6E2", swatch: "#ffffff" },
  soft: { bg: "#FAF8F3", surface: "#FFFFFF", ink: "#1A1A17", ink3: "#5A554A", border: "#E7E2D6", swatch: "#faf8f3" },
  cool: { bg: "#F1F5F9", surface: "#FFFFFF", ink: "#0F172A", ink3: "#475569", border: "#E2E8F0", swatch: "#f1f5f9" },
  dark: { bg: "#0A0A0A", surface: "#161616", ink: "#FAFAFA", ink3: "#A3A3A3", border: "#262626", swatch: "#0a0a0a" },
};

function appearanceOf(appearance: Record<string, string>) {
  const ap = (key: string, fallback: string) => appearance[key] ?? fallback;
  const density = ap("density", "comfortable");
  return {
    ap,
    density,
    gap: density === "compact" ? 8 : density === "spacious" ? 20 : GAP,
    cardStyle: ap("cardStyle", "outlined"),
    theme: THEMES[ap("theme", "light")] ?? THEMES.light,
    header: ap("header", "kpi-banner"),
  };
}

function cardStyleFor(w: { x: number; y: number; w: number; h: number }, look: ReturnType<typeof appearanceOf>): CSSProperties {
  return {
    gridColumn: `${w.x + 1} / span ${w.w}`,
    gridRow: `${w.y + 1} / span ${w.h}`,
    background: look.theme.surface,
    color: look.theme.ink,
    border: look.cardStyle === "flat" ? "1px solid transparent" : `1px solid ${look.theme.border}`,
    boxShadow: look.cardStyle === "elevated" ? "0 4px 12px rgba(0,0,0,0.08)" : "none",
  };
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="ds-status inline-flex items-center [gap:8px] [color:var(--muted)] [font-size:0.9em] ds-dash-pad [padding:24px_32px]">
      <span className="ds-spinner [&.ds-progress-mark]:[width:10px] [&.ds-progress-mark]:[height:10px] [width:14px] [height:14px] [border:2px_solid_var(--border)] [&&]:[border-top-color:var(--accent)] [border-radius:50%] [animation:fh-spin_0.8s_linear_infinite]" aria-hidden /> {label}
    </div>
  );
}

// ---- list ----

function DashboardList({ onOpen }: { onOpen: (id: string) => void }) {
  const runtime = useRuntime();
  const { t, locale } = useLocale();
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDashboards(await dsApi.listDashboards(runtime));
    } catch {
      setDashboards([]);
    }
    setLoading(false);
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    setCreating(true);
    try {
      const created = await dsApi.createDashboard(runtime, { title: t("dsx.untitled") });
      onOpen(created.id);
    } catch {
      toast.error(t("dsx.saveFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setConfirmId(null);
    try {
      await dsApi.deleteDashboard(runtime, id);
      await load();
    } catch {
      toast.error(t("dsx.saveFailed"));
    }
  }

  return (
    <div className="fh-data-studio-admin">
      <div className="fh-data-studio-admin-header [margin-bottom:16px] [&_h2]:m-0 [&_h2]:[font-size:1.2em] ds-dash-list-head flex items-start justify-between [gap:12px] [&_p]:[margin:4px_0_0]">
        <div>
          <h2>{t("dsx.dashboardsTitle")}</h2>
          <p className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t("dsx.dashboardsSubtitle")}</p>
        </div>
        <Button variant="primary" onClick={() => void create()} disabled={creating}>
          <PlusIcon size={14} /> {t("dsx.newDashboard")}
        </Button>
      </div>

      {loading ? (
        <p className="fh-data-studio-loading [padding:48px] text-center [color:var(--muted)]">{t("dataStudio.loading")}</p>
      ) : dashboards.length === 0 ? (
        <div className="ds-dash-empty flex flex-col items-center [gap:10px] [margin-top:18px] [padding:40px_16px] [border:1px_dashed_var(--border)] [border-radius:var(--radius-lg)] [color:var(--muted)] text-center">
          <DashboardsIcon size={28} />
          <p>{t("dsx.noDashboardsHint")}</p>
        </div>
      ) : (
        <div className="ds-dash-cards grid [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))] [gap:14px] [margin-top:18px]">
          {dashboards.map((d) => (
            <div key={d.id} className="ds-dash-card relative flex flex-col [border:1px_solid_var(--border)] [border-radius:var(--radius-lg)] [transition:border-color_var(--fh-duration-fast,0.1s)] [&:hover]:[border-color:var(--accent)] [&:hover_.ds-dash-card-delete]:[opacity:1]">
              <button type="button" className="ds-dash-card-main [height:auto] flex flex-col items-start [gap:6px] [padding:14px] [border:0] [background:none] [color:var(--fg)] [font:inherit] text-left" onClick={() => onOpen(d.id)}>
                <span className="ds-dash-card-title flex items-center [gap:6px] font-semibold [&_svg]:[color:var(--accent)]">
                  <DashboardsIcon size={15} /> {d.title}
                </span>
                {d.description && <span className="ds-dash-card-desc [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical] overflow-hidden [color:var(--muted)] [font-size:0.85em]">{d.description}</span>}
                <span className="ds-muted [color:var(--muted)] [font-size:0.85em] ds-dash-card-meta [margin-top:auto]">
                  {t("dsx.chartsCount", { n: String(d.widget_count) })} · {new Date(d.updated_at).toLocaleDateString(locale === "vi" ? "vi-VN" : "en-US")}
                </span>
              </button>
              {confirmId === d.id ? (
                <div className="ds-dash-confirm flex flex-wrap items-center [gap:8px] [padding:10px_14px] [border-top:1px_solid_var(--border-subtle)] [font-size:0.85em]">
                  <span>{t("dsx.confirmDelete", { name: d.title })}</span>
                  <Button variant="primary" onClick={() => void remove(d.id)}>
                    {t("dsx.deleteDashboard")}
                  </Button>
                  <Button variant="outline" onClick={() => setConfirmId(null)}>
                    {t("dsx.cancel")}
                  </Button>
                </div>
              ) : (
                <IconButton className="ds-dash-card-delete absolute [top:8px] [right:8px] [opacity:0]" onClick={() => setConfirmId(d.id)} title={t("dsx.deleteDashboard")}>
                  <TrashIcon size={14} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- shared widget body ----

function WidgetBody({ widget, look }: { widget: WidgetOut; look: ReturnType<typeof appearanceOf> }) {
  const { t } = useLocale();
  if (widget.kind === "text") {
    return (
      <div className="ds-dash-text [font-size:0.9em] [line-height:1.6] whitespace-pre-wrap" style={{ color: look.theme.ink3 }}>
        {widget.text}
      </div>
    );
  }
  if (!widget.chart) return <div className="ds-muted [color:var(--muted)] [font-size:0.85em] ds-dash-center flex h-full items-center justify-center">{t("dsx.deletedChart")}</div>;
  const spec = chartOutToSpec(widget.chart, widget.title_override);
  return (
    <>
      <div className="ds-dash-widget-title [margin-bottom:6px] overflow-hidden [font-size:0.95em] font-semibold text-ellipsis whitespace-nowrap">{widget.title_override || widget.chart.title_override || chartTitle(widget.chart, t("conversation.dsTable"))}</div>
      <div className="ds-dash-widget-plot [flex:1] min-h-0">
        <ChartView chart={spec} height="100%" chromeless />
      </div>
    </>
  );
}

// ---- report ----

function DashboardReport({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit?: () => void }) {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [dash, setDash] = useState<DashboardDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    dsApi
      .getDashboard(runtime, id)
      .then((d) => !cancelled && setDash(d))
      .catch(() => !cancelled && setDash(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [runtime, id]);

  // "Lưu PDF": print the report (choose "Save as PDF"). The charts are inline SVG so they stay vector-crisp, and
  // the print stylesheet (style.css `body.ds-printing`) hides the app chrome so only the report is on the page.
  function savePdf(): void {
    if (!dash) return;
    const previousTitle = document.title;
    document.title = dash.title || "dashboard"; // becomes the default file name
    document.body.classList.add("ds-printing");
    const done = () => {
      document.body.classList.remove("ds-printing");
      document.title = previousTitle;
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  }

  if (loading) return <Spinner label={t("dataStudio.loading")} />;
  if (!dash) return <div className="ds-dash-pad [padding:24px_32px] ds-muted [color:var(--muted)] [font-size:0.85em]">{t("dsx.notFound")}</div>;

  const look = appearanceOf(dash.appearance);
  return (
    <div className="ds-dash-page">
      <div className="ds-dash-topbar flex-none flex items-center justify-between [gap:12px] [padding:10px_20px] [border-bottom:1px_solid_var(--border)]">
        <button type="button" className="ds-dash-back inline-flex items-center [gap:6px] [height:auto] p-0 [border:0] [background:none] [color:var(--muted)] [font:inherit] [&&]:font-semibold [&:hover]:[color:var(--fg)]" onClick={onBack}>
          <ArrowLeftIcon size={15} /> {t("dsx.back")}
        </button>
        <div className="ds-toolbar flex flex-wrap items-center [gap:8px] [&_button]:inline-flex [&_button]:items-center [&_button]:[gap:6px] [&_button]:whitespace-nowrap">
          <Button variant="outline" onClick={savePdf}>
            {t("dsx.savePdf")}
          </Button>
          {onEdit && (
            <Button variant="primary" onClick={onEdit}>
              {t("dsx.edit")}
            </Button>
          )}
        </div>
      </div>

      <div className="ds-dash-scroll [flex:1] min-w-0 min-h-0 overflow-auto ds-report" style={{ background: look.theme.bg, color: look.theme.ink }}>
        <DashboardHeader title={dash.title} description={dash.description} variant={look.header} banner={t("dsx.reportBanner")} />
        <div className="ds-dash-body [max-width:1152px] [margin:0_auto] [padding:28px_32px]">
          {dash.widgets.length === 0 ? (
            <div className="ds-dash-empty flex flex-col items-center [gap:10px] [margin-top:18px] [padding:40px_16px] [border:1px_dashed_var(--border)] [border-radius:var(--radius-lg)] [color:var(--muted)] text-center">{t("dsx.noCharts")}</div>
          ) : (
            <div className="ds-dash-grid grid [grid-template-columns:repeat(12,1fr)] [grid-auto-rows:70px]" style={{ gap: look.gap }}>
              {dash.widgets.map((w) => (
                <div key={w.id} className="ds-dash-widget flex flex-col min-w-0 [padding:14px] [border-radius:12px] overflow-hidden" style={cardStyleFor(w, look)}>
                  <WidgetBody widget={w} look={look} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- builder ----

// a local editable widget: server layout + (for charts) the resolved chart to render
interface EditWidget extends WidgetOut {
  key: string; // stable local key
  isNew: boolean; // not on the server yet
}

const fromServer = (w: WidgetOut): EditWidget => ({ ...w, key: `w-${w.id}`, isNew: false });

function DashboardBuilder({ id, onBack, onPreview }: { id: string; onBack: () => void; onPreview: () => void }) {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [dash, setDash] = useState<DashboardDetail | null>(null);
  const [widgets, setWidgets] = useState<EditWidget[]>([]);
  const [appearance, setAppearance] = useState<Record<string, string>>({});
  const [available, setAvailable] = useState<AvailableChart[]>([]);
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([dsApi.getDashboard(runtime, id), dsApi.availableCharts(runtime)])
      .then(([d, charts]) => {
        if (cancelled) return;
        setDash(d);
        setTitle(d.title);
        setWidgets(d.widgets.map(fromServer));
        setAppearance(d.appearance ?? {});
        setAvailable(charts);
      })
      .catch(() => !cancelled && setDash(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [runtime, id]);

  const look = appearanceOf(appearance);
  const setAp = (key: string, value: string) => setAppearance((prev) => ({ ...prev, [key]: value }));
  // rows needed = lowest widget bottom + a spare row to drop into
  const totalRows = useMemo(() => Math.max(6, ...widgets.map((w) => w.y + w.h)) + 1, [widgets]);

  const patchWidget = useCallback((key: string, patch: Partial<EditWidget>) => {
    setWidgets((prev) => prev.map((w) => (w.key === key ? { ...w, ...patch } : w)));
  }, []);

  const cellSize = useCallback(() => {
    const width = gridRef.current ? gridRef.current.clientWidth : 1200;
    const colW = (width - look.gap * (COLS - 1)) / COLS;
    return { colW: colW + look.gap, rowH: ROW_H + look.gap };
  }, [look.gap]);

  // Drag = move, corner handle = resize; both snap to the 12-column grid via pointer events on window.
  function startPointer(e: React.PointerEvent, w: EditWidget, mode: "move" | "resize"): void {
    e.preventDefault();
    if (mode === "resize") e.stopPropagation();
    setSelected(w.key);
    const { colW, rowH } = cellSize();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { x: w.x, y: w.y, w: w.w, h: w.h };

    function move(ev: PointerEvent): void {
      const dx = Math.round((ev.clientX - startX) / colW);
      const dy = Math.round((ev.clientY - startY) / rowH);
      if (mode === "move") patchWidget(w.key, { x: Math.max(0, Math.min(COLS - orig.w, orig.x + dx)), y: Math.max(0, orig.y + dy) });
      else patchWidget(w.key, { w: Math.max(2, Math.min(COLS - orig.x, orig.w + dx)), h: Math.max(2, orig.h + dy) });
    }
    function up(): void {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Widgets are added locally only (no server round-trip): a server add would re-fetch the list and resurrect
  // widgets the user just deleted in this unsaved session. Everything is persisted by "Xuất bản".
  const bottom = () => Math.max(0, ...widgets.map((w) => w.y + w.h));
  function addChart(c: AvailableChart): void {
    setWidgets((prev) => [
      ...prev,
      {
        key: `new-${Date.now()}`, isNew: true, id: "", seq: prev.length, kind: "chart", x: 0, y: bottom(), w: 6, h: 4,
        title_override: null, note: null, text: null, config: {}, chart: c.chart,
      },
    ]);
  }
  function addText(): void {
    setWidgets((prev) => [
      ...prev,
      {
        key: `new-${Date.now()}`, isNew: true, id: "", seq: prev.length, kind: "text", x: 0, y: bottom(), w: 12, h: 2,
        title_override: null, note: null, text: t("dsx.textPlaceholder"), config: {}, chart: null,
      },
    ]);
  }
  function removeWidget(key: string): void {
    setWidgets((prev) => prev.filter((w) => w.key !== key));
    if (selected === key) setSelected(null);
  }

  // a column preset reflows every chart widget into rows of the preset width
  function applyPreset(key: string, width: number): void {
    setAp("layout", key);
    setWidgets((prev) => {
      const perRow = Math.floor(COLS / width);
      return prev.map((wd, i) =>
        wd.kind === "text" ? { ...wd, x: 0, w: COLS } : { ...wd, x: (i % perRow) * width, y: Math.floor(i / perRow) * wd.h, w: width },
      );
    });
  }

  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      await dsApi.saveWidgets(
        runtime,
        id,
        widgets.map((w) => ({
          id: w.isNew ? null : w.id, kind: w.kind, chart_id: w.chart?.id ?? null, x: w.x, y: w.y, w: w.w, h: w.h,
          title_override: w.title_override, note: w.note, text: w.text,
        })),
      );
      await dsApi.updateDashboard(runtime, id, { title, appearance });
      return true;
    } catch {
      toast.error(t("dsx.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function publish(): Promise<void> {
    if (!(await save())) return;
    toast.success(t("dsx.published"));
    const fresh = await dsApi.getDashboard(runtime, id);
    setWidgets(fresh.widgets.map(fromServer)); // adopt the server ids of the widgets just created
  }

  if (loading) return <Spinner label={t("dataStudio.loading")} />;
  if (!dash) return <div className="ds-dash-pad [padding:24px_32px] ds-muted [color:var(--muted)] [font-size:0.85em]">{t("dsx.notFound")}</div>;

  const presets = [
    { key: "two-col", label: t("dsx.layoutTwoCol"), w: 6 },
    { key: "three-col", label: t("dsx.layoutThreeCol"), w: 4 },
    { key: "hero-grid", label: t("dsx.layoutHeroGrid"), w: 6 },
    { key: "one-col", label: t("dsx.layoutOneCol"), w: 12 },
  ];
  const densities = [
    { key: "compact", label: t("dsx.densityCompact") },
    { key: "comfortable", label: t("dsx.densityComfortable") },
    { key: "spacious", label: t("dsx.densitySpacious") },
  ];
  const themes = [
    { key: "light", label: t("dsx.themeLight") },
    { key: "soft", label: t("dsx.themeSoft") },
    { key: "cool", label: t("dsx.themeCool") },
    { key: "dark", label: t("dsx.themeDark") },
  ];
  const cardStyles = [
    { key: "flat", label: t("dsx.cardFlat") },
    { key: "outlined", label: t("dsx.cardOutlined") },
    { key: "elevated", label: t("dsx.cardElevated") },
  ];
  const headers = [
    { key: "minimal", label: t("dsx.headerMinimal"), note: t("dsx.headerMinimalNote") },
    { key: "kpi-banner", label: t("dsx.headerKpi"), note: t("dsx.headerKpiNote") },
    { key: "gradient", label: t("dsx.headerGradient"), note: t("dsx.headerGradientNote") },
    { key: "two-tone", label: t("dsx.headerTwoTone"), note: t("dsx.headerTwoToneNote") },
  ];

  return (
    <div className="ds-dash-page">
      <div className="ds-dash-topbar flex-none flex items-center justify-between [gap:12px] [padding:10px_20px] [border-bottom:1px_solid_var(--border)]">
        <button type="button" className="ds-dash-back inline-flex items-center [gap:6px] [height:auto] p-0 [border:0] [background:none] [color:var(--muted)] [font:inherit] [&&]:font-semibold [&:hover]:[color:var(--fg)]" onClick={onBack}>
          <ArrowLeftIcon size={15} /> {t("dsx.builderTitle")}
        </button>
        <div className="ds-toolbar flex flex-wrap items-center [gap:8px] [&_button]:inline-flex [&_button]:items-center [&_button]:[gap:6px] [&_button]:whitespace-nowrap">
          <Button variant="outline" disabled={saving} onClick={() => void save().then((ok) => ok && onPreview())}>
            {t("dsx.preview")}
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void publish()}>
            <CheckIcon size={14} /> {t("dsx.publish")}
          </Button>
        </div>
      </div>

      <div className="ds-builder [flex:1] min-h-0 flex overflow-hidden">
        <aside className="ds-builder-side flex-none [width:250px] flex flex-col [gap:8px] [padding:14px] overflow-y-auto [border-right:1px_solid_var(--border)]">
          <div className="ds-section-label [margin-bottom:6px] [color:var(--muted)] [font-size:0.7em] font-semibold [letter-spacing:0.04em] [text-transform:uppercase]">{t("dsx.fromChats")}</div>
          {available.length === 0 ? (
            <p className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t("dsx.noSavedCharts")}</p>
          ) : (
            available.map((c) => (
              <button key={c.chart_id} type="button" className="ds-builder-chart [height:auto] flex flex-col items-start [gap:2px] [padding:8px_10px] [border:1px_solid_var(--border)] [border-radius:var(--radius-md)] [background:none] [color:var(--fg)] [font:inherit] [&&]:[font-size:0.9em] text-left [&:hover]:[border-color:var(--accent)] [&:hover]:[background:color-mix(in_srgb,var(--accent)_8%,transparent)]" onClick={() => addChart(c)} title={c.conversation_title ?? undefined}>
                <span className="ds-builder-chart-title flex items-center [gap:6px] font-semibold [&_svg]:[color:var(--accent)]">
                  <ChartBarIcon size={13} /> {chartTitle(c, t("conversation.dsTable")) || c.type}
                </span>
                <span className="ds-muted [color:var(--muted)] [font-size:0.85em]">{c.type}{c.conversation_title ? ` · ${c.conversation_title}` : ""}</span>
              </button>
            ))
          )}
          <div className="ds-section-label [margin-bottom:6px] [color:var(--muted)] [font-size:0.7em] font-semibold [letter-spacing:0.04em] [text-transform:uppercase] ds-builder-divider [margin-top:10px] [padding-top:12px] [border-top:1px_solid_var(--border-subtle)]">{t("dsx.addWidget")}</div>
          <button type="button" className="ds-builder-chart [height:auto] flex flex-col items-start [gap:2px] [padding:8px_10px] [border:1px_solid_var(--border)] [border-radius:var(--radius-md)] [background:none] [color:var(--fg)] [font:inherit] [&&]:[font-size:0.9em] text-left [&:hover]:[border-color:var(--accent)] [&:hover]:[background:color-mix(in_srgb,var(--accent)_8%,transparent)]" onClick={addText}>
            {t("dsx.textWidget")}
          </button>
        </aside>

        <main className="ds-dash-scroll [flex:1] min-w-0 min-h-0 overflow-auto" style={{ background: look.theme.bg, color: look.theme.ink }}>
          <div className="ds-builder-preview-header pointer-events-none">
            <DashboardHeader title={title || t("dsx.dashboardTitlePh")} description={dash.description} variant={look.header} banner={t("dsx.reportBanner")} />
          </div>
          <div className="ds-dash-body [max-width:1152px] [margin:0_auto] [padding:28px_32px]">
            <input
              className="ds-builder-title w-full [margin-bottom:4px] p-0 [border:0] [background:transparent] [font:inherit] [&&]:[font-size:1.7em] [&&]:font-bold [outline:none]"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("dsx.dashboardTitlePh")}
              style={{ color: look.theme.ink }}
            />
            <p className="ds-muted [color:var(--muted)] [font-size:0.85em] ds-builder-hint [margin:0_0_14px]">{t("dsx.dragHint")}</p>
            <div
              ref={gridRef}
              className="ds-dash-grid grid [grid-template-columns:repeat(12,1fr)] [grid-auto-rows:70px] ds-builder-grid relative"
              style={{ gap: look.gap, minHeight: totalRows * (ROW_H + look.gap) }}
            >
              {widgets.map((w) => {
                const isSelected = selected === w.key;
                return (
                  <div
                    key={w.key}
                    className={`ds-dash-widget flex flex-col min-w-0 [border-radius:12px] overflow-hidden ds-builder-widget [padding:12px] relative [cursor:move] select-none [touch-action:none] [&.selected]:![box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_25%,transparent)] [&:hover_.ds-builder-remove]:[opacity:1]${isSelected ? " selected" : ""}`}
                    style={{ ...cardStyleFor(w, look), ...(isSelected ? { border: "1px solid var(--accent)" } : {}) }}
                    onPointerDown={(e) => startPointer(e, w, "move")}
                  >
                    <button
                      type="button"
                      className="ds-builder-remove absolute [top:6px] [right:6px] [z-index:2] inline-flex [height:auto] [padding:4px] [border:0] [border-radius:6px] [background:transparent] [color:var(--muted)] [opacity:0] [&:hover]:[background:color-mix(in_srgb,var(--error)_14%,transparent)] [&:hover]:[color:var(--error)]"
                      title={t("dsx.deleteWidget")}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeWidget(w.key);
                      }}
                    >
                      <TrashIcon size={13} />
                    </button>
                    {w.kind === "text" ? (
                      <textarea
                        className="ds-builder-textarea w-full h-full [resize:none] [border:0] [background:transparent] [color:inherit] [font:inherit] [&&]:[font-size:0.9em] [outline:none]"
                        value={w.text ?? ""}
                        placeholder={t("dsx.textPlaceholder")}
                        onPointerDown={(e) => e.stopPropagation()}
                        onChange={(e) => patchWidget(w.key, { text: e.target.value })}
                      />
                    ) : (
                      <div className="ds-builder-widget-inner flex flex-col h-full overflow-hidden pointer-events-none">
                        <WidgetBody widget={w} look={look} />
                      </div>
                    )}
                    <div className="ds-builder-resize absolute [right:0] [bottom:0] [width:16px] [height:16px] [border-bottom-right-radius:12px] [background:linear-gradient(135deg,transparent_50%,var(--border)_50%,var(--border)_70%,transparent_70%)] [cursor:se-resize]" onPointerDown={(e) => startPointer(e, w, "resize")} />
                  </div>
                );
              })}
            </div>
          </div>
        </main>

        <aside className="ds-builder-side flex-none flex flex-col [padding:14px] overflow-y-auto ds-builder-panel [width:280px] [gap:18px] [border-right:0] [border-left:1px_solid_var(--border)]">
          <PanelSection title={t("dsx.layout")}>
            <div className="ds-panel-grid grid [gap:8px] ds-panel-grid-2 [grid-template-columns:repeat(2,1fr)]">
              {presets.map((p) => (
                <PanelBtn key={p.key} active={look.ap("layout", "") === p.key} onClick={() => applyPreset(p.key, p.w)}>
                  {p.label}
                </PanelBtn>
              ))}
            </div>
          </PanelSection>
          <PanelSection title={t("dsx.density")}>
            <div className="ds-panel-grid grid [gap:8px] ds-panel-grid-3 [grid-template-columns:repeat(3,1fr)]">
              {densities.map((d) => (
                <PanelBtn key={d.key} active={look.density === d.key} onClick={() => setAp("density", d.key)}>
                  {d.label}
                </PanelBtn>
              ))}
            </div>
          </PanelSection>
          <PanelSection title={t("dsx.themeSection")}>
            <div className="ds-panel-grid grid [gap:8px] ds-panel-grid-4 [grid-template-columns:repeat(4,1fr)]">
              {themes.map((th) => (
                <button
                  key={th.key}
                  type="button"
                  title={th.label}
                  className={`ds-theme-swatch [height:36px] p-0 [border:2px_solid_var(--border)] [border-radius:var(--radius-md)] [&.active]:[border-color:var(--accent)]${look.ap("theme", "light") === th.key ? " active" : ""}`}
                  style={{ background: THEMES[th.key].swatch }}
                  onClick={() => setAp("theme", th.key)}
                />
              ))}
            </div>
          </PanelSection>
          <PanelSection title={t("dsx.cardStyle")}>
            <div className="ds-panel-grid grid [gap:8px] ds-panel-grid-3 [grid-template-columns:repeat(3,1fr)]">
              {cardStyles.map((c) => (
                <PanelBtn key={c.key} active={look.cardStyle === c.key} onClick={() => setAp("cardStyle", c.key)}>
                  {c.label}
                </PanelBtn>
              ))}
            </div>
          </PanelSection>
          <PanelSection title={t("dsx.headerSection")}>
            <div className="ds-panel-stack flex flex-col [gap:8px]">
              {headers.map((h) => (
                <button
                  key={h.key}
                  type="button"
                  className={`ds-panel-option [height:auto] [padding:6px_8px] [border:1px_solid_var(--border)] [border-radius:var(--radius-md)] [background:none] [color:var(--fg)] [font:inherit] [&&]:[font-size:0.9em] [&:hover]:[background:var(--surface)] [&.active]:[border-color:var(--accent)] [&&.active]:[background:color-mix(in_srgb,var(--accent)_10%,transparent)] [&.active]:[color:var(--accent-text)] [&.active]:font-semibold flex flex-col items-start [gap:2px] text-left${look.header === h.key ? " active" : ""}`}
                  onClick={() => setAp("header", h.key)}
                >
                  <span className="ds-panel-option-title font-semibold">{h.label}</span>
                  <span className="ds-muted [color:var(--muted)] [font-size:0.85em]">{h.note}</span>
                </button>
              ))}
            </div>
          </PanelSection>
        </aside>
      </div>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ds-panel-section flex flex-col [gap:8px] [&_.ds-section-label]:[margin-bottom:0]">
      <div className="ds-section-label [margin-bottom:6px] [color:var(--muted)] [font-size:0.7em] font-semibold [letter-spacing:0.04em] [text-transform:uppercase]">{title}</div>
      {children}
    </div>
  );
}

function PanelBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`ds-panel-btn [height:auto] [padding:6px_8px] [border:1px_solid_var(--border)] [border-radius:var(--radius-md)] [background:none] [color:var(--fg)] [font:inherit] [&&]:[font-size:0.9em] [&:hover]:[background:var(--surface)] [&.active]:[border-color:var(--accent)] [&&.active]:[background:color-mix(in_srgb,var(--accent)_10%,transparent)] [&.active]:[color:var(--accent-text)] [&.active]:font-semibold${active ? " active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

// ---- entry ----

type Mode = { mode: "list" } | { mode: "report"; id: string } | { mode: "edit"; id: string };

// Every user has their own dashboards (docs/data-studio-user-dashboards-plan.md): list, report and builder alike.
export function DataStudioDashboards() {
  const [state, setState] = useState<Mode>({ mode: "list" });
  if (state.mode === "report") {
    const id = state.id;
    return (
      <DashboardReport
        key={id}
        id={id}
        onBack={() => setState({ mode: "list" })}
        onEdit={() => setState({ mode: "edit", id })}
      />
    );
  }
  if (state.mode === "edit") {
    return <DashboardBuilder key={state.id} id={state.id} onBack={() => setState({ mode: "report", id: state.id })} onPreview={() => setState({ mode: "report", id: state.id })} />;
  }
  return <DashboardList onOpen={(id) => setState({ mode: "report", id })} />;
}
