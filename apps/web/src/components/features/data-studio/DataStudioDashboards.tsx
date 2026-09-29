// Dashboards section of Data Studio — a port of the reference UI's three dashboard pages
// (examples/example-data-studio-agent: dashboards/page.tsx list, [id]/page.tsx report, [id]/edit/page.tsx builder)
// onto this app's shell and the gateway's dashboard API (dsApi.ts):
//   * list    — cards with widget count / last update, "Dashboard mới", delete.
//   * report  — themed header + 12-column widget grid (theme / density / card style from `appearance`),
//               "Lưu PDF" (browser print of the report), "Chỉnh sửa".
//   * builder — charts saved from conversations (left), drag / resize canvas (center), layout / density / theme /
//               card style / header panel (right), "Xem trước" and "Xuất bản" (bulk save).
// State lives in this component (no URL routes), like the project hub.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";

import { ArrowLeftIcon, ChartBarIcon, CheckIcon, DashboardsIcon, PlusIcon, TrashIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";
import { ChartView } from "../conversation/ChartView.tsx";
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
    <div className="ds-status ds-dash-pad">
      <span className="ds-spinner" aria-hidden /> {label}
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
      <div className="fh-data-studio-admin-header ds-dash-list-head">
        <div>
          <h2>{t("dsx.dashboardsTitle")}</h2>
          <p className="ds-muted">{t("dsx.dashboardsSubtitle")}</p>
        </div>
        <Button variant="primary" onClick={() => void create()} disabled={creating}>
          <PlusIcon size={14} /> {t("dsx.newDashboard")}
        </Button>
      </div>

      {loading ? (
        <p className="fh-data-studio-loading">{t("dataStudio.loading")}</p>
      ) : dashboards.length === 0 ? (
        <div className="ds-dash-empty">
          <DashboardsIcon size={28} />
          <p>{t("dsx.noDashboardsHint")}</p>
        </div>
      ) : (
        <div className="ds-dash-cards">
          {dashboards.map((d) => (
            <div key={d.id} className="ds-dash-card">
              <button type="button" className="ds-dash-card-main" onClick={() => onOpen(d.id)}>
                <span className="ds-dash-card-title">
                  <DashboardsIcon size={15} /> {d.title}
                </span>
                {d.description && <span className="ds-dash-card-desc">{d.description}</span>}
                <span className="ds-muted ds-dash-card-meta">
                  {t("dsx.chartsCount", { n: String(d.widget_count) })} · {new Date(d.updated_at).toLocaleDateString(locale === "vi" ? "vi-VN" : "en-US")}
                </span>
              </button>
              {confirmId === d.id ? (
                <div className="ds-dash-confirm">
                  <span>{t("dsx.confirmDelete", { name: d.title })}</span>
                  <Button variant="primary" onClick={() => void remove(d.id)}>
                    {t("dsx.deleteDashboard")}
                  </Button>
                  <Button variant="outline" onClick={() => setConfirmId(null)}>
                    {t("dsx.cancel")}
                  </Button>
                </div>
              ) : (
                <IconButton className="ds-dash-card-delete" onClick={() => setConfirmId(d.id)} title={t("dsx.deleteDashboard")}>
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
      <div className="ds-dash-text" style={{ color: look.theme.ink3 }}>
        {widget.text}
      </div>
    );
  }
  if (!widget.chart) return <div className="ds-muted ds-dash-center">{t("dsx.deletedChart")}</div>;
  const spec = chartOutToSpec(widget.chart, widget.title_override);
  return (
    <>
      <div className="ds-dash-widget-title">{widget.title_override || widget.chart.title_override || widget.chart.title}</div>
      <div className="ds-dash-widget-plot">
        <ChartView chart={spec} height="100%" chromeless />
      </div>
    </>
  );
}

// ---- report ----

function DashboardReport({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: () => void }) {
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
  if (!dash) return <div className="ds-dash-pad ds-muted">{t("dsx.notFound")}</div>;

  const look = appearanceOf(dash.appearance);
  return (
    <div className="ds-dash-page">
      <div className="ds-dash-topbar">
        <button type="button" className="ds-dash-back" onClick={onBack}>
          <ArrowLeftIcon size={15} /> {t("dsx.back")}
        </button>
        <div className="ds-toolbar">
          <Button variant="outline" onClick={savePdf}>
            {t("dsx.savePdf")}
          </Button>
          <Button variant="primary" onClick={onEdit}>
            {t("dsx.edit")}
          </Button>
        </div>
      </div>

      <div className="ds-dash-scroll ds-report" style={{ background: look.theme.bg, color: look.theme.ink }}>
        <DashboardHeader title={dash.title} description={dash.description} variant={look.header} banner={t("dsx.reportBanner")} />
        <div className="ds-dash-body">
          {dash.widgets.length === 0 ? (
            <div className="ds-dash-empty">{t("dsx.noCharts")}</div>
          ) : (
            <div className="ds-dash-grid" style={{ gap: look.gap }}>
              {dash.widgets.map((w) => (
                <div key={w.id} className="ds-dash-widget" style={cardStyleFor(w, look)}>
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
  if (!dash) return <div className="ds-dash-pad ds-muted">{t("dsx.notFound")}</div>;

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
      <div className="ds-dash-topbar">
        <button type="button" className="ds-dash-back" onClick={onBack}>
          <ArrowLeftIcon size={15} /> {t("dsx.builderTitle")}
        </button>
        <div className="ds-toolbar">
          <Button variant="outline" disabled={saving} onClick={() => void save().then((ok) => ok && onPreview())}>
            {t("dsx.preview")}
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void publish()}>
            <CheckIcon size={14} /> {t("dsx.publish")}
          </Button>
        </div>
      </div>

      <div className="ds-builder">
        <aside className="ds-builder-side">
          <div className="ds-section-label">{t("dsx.fromChats")}</div>
          {available.length === 0 ? (
            <p className="ds-muted">{t("dsx.noSavedCharts")}</p>
          ) : (
            available.map((c) => (
              <button key={c.chart_id} type="button" className="ds-builder-chart" onClick={() => addChart(c)} title={c.conversation_title ?? undefined}>
                <span className="ds-builder-chart-title">
                  <ChartBarIcon size={13} /> {c.title || c.type}
                </span>
                <span className="ds-muted">{c.type}{c.conversation_title ? ` · ${c.conversation_title}` : ""}</span>
              </button>
            ))
          )}
          <div className="ds-section-label ds-builder-divider">{t("dsx.addWidget")}</div>
          <button type="button" className="ds-builder-chart" onClick={addText}>
            {t("dsx.textWidget")}
          </button>
        </aside>

        <main className="ds-dash-scroll" style={{ background: look.theme.bg, color: look.theme.ink }}>
          <div className="ds-builder-preview-header">
            <DashboardHeader title={title || t("dsx.dashboardTitlePh")} description={dash.description} variant={look.header} banner={t("dsx.reportBanner")} />
          </div>
          <div className="ds-dash-body">
            <input
              className="ds-builder-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("dsx.dashboardTitlePh")}
              style={{ color: look.theme.ink }}
            />
            <p className="ds-muted ds-builder-hint">{t("dsx.dragHint")}</p>
            <div
              ref={gridRef}
              className="ds-dash-grid ds-builder-grid"
              style={{ gap: look.gap, minHeight: totalRows * (ROW_H + look.gap) }}
            >
              {widgets.map((w) => {
                const isSelected = selected === w.key;
                return (
                  <div
                    key={w.key}
                    className={`ds-dash-widget ds-builder-widget${isSelected ? " selected" : ""}`}
                    style={{ ...cardStyleFor(w, look), ...(isSelected ? { border: "1px solid var(--accent)" } : {}) }}
                    onPointerDown={(e) => startPointer(e, w, "move")}
                  >
                    <button
                      type="button"
                      className="ds-builder-remove"
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
                        className="ds-builder-textarea"
                        value={w.text ?? ""}
                        placeholder={t("dsx.textPlaceholder")}
                        onPointerDown={(e) => e.stopPropagation()}
                        onChange={(e) => patchWidget(w.key, { text: e.target.value })}
                      />
                    ) : (
                      <div className="ds-builder-widget-inner">
                        <WidgetBody widget={w} look={look} />
                      </div>
                    )}
                    <div className="ds-builder-resize" onPointerDown={(e) => startPointer(e, w, "resize")} />
                  </div>
                );
              })}
            </div>
          </div>
        </main>

        <aside className="ds-builder-side ds-builder-panel">
          <PanelSection title={t("dsx.layout")}>
            <div className="ds-panel-grid ds-panel-grid-2">
              {presets.map((p) => (
                <PanelBtn key={p.key} active={look.ap("layout", "") === p.key} onClick={() => applyPreset(p.key, p.w)}>
                  {p.label}
                </PanelBtn>
              ))}
            </div>
          </PanelSection>
          <PanelSection title={t("dsx.density")}>
            <div className="ds-panel-grid ds-panel-grid-3">
              {densities.map((d) => (
                <PanelBtn key={d.key} active={look.density === d.key} onClick={() => setAp("density", d.key)}>
                  {d.label}
                </PanelBtn>
              ))}
            </div>
          </PanelSection>
          <PanelSection title={t("dsx.themeSection")}>
            <div className="ds-panel-grid ds-panel-grid-4">
              {themes.map((th) => (
                <button
                  key={th.key}
                  type="button"
                  title={th.label}
                  className={`ds-theme-swatch${look.ap("theme", "light") === th.key ? " active" : ""}`}
                  style={{ background: THEMES[th.key].swatch }}
                  onClick={() => setAp("theme", th.key)}
                />
              ))}
            </div>
          </PanelSection>
          <PanelSection title={t("dsx.cardStyle")}>
            <div className="ds-panel-grid ds-panel-grid-3">
              {cardStyles.map((c) => (
                <PanelBtn key={c.key} active={look.cardStyle === c.key} onClick={() => setAp("cardStyle", c.key)}>
                  {c.label}
                </PanelBtn>
              ))}
            </div>
          </PanelSection>
          <PanelSection title={t("dsx.headerSection")}>
            <div className="ds-panel-stack">
              {headers.map((h) => (
                <button
                  key={h.key}
                  type="button"
                  className={`ds-panel-option${look.header === h.key ? " active" : ""}`}
                  onClick={() => setAp("header", h.key)}
                >
                  <span className="ds-panel-option-title">{h.label}</span>
                  <span className="ds-muted">{h.note}</span>
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
    <div className="ds-panel-section">
      <div className="ds-section-label">{title}</div>
      {children}
    </div>
  );
}

function PanelBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`ds-panel-btn${active ? " active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

// ---- entry ----

type Mode = { mode: "list" } | { mode: "report"; id: string } | { mode: "edit"; id: string };

export function DataStudioDashboards() {
  const [state, setState] = useState<Mode>({ mode: "list" });
  if (state.mode === "report") {
    return <DashboardReport key={state.id} id={state.id} onBack={() => setState({ mode: "list" })} onEdit={() => setState({ mode: "edit", id: state.id })} />;
  }
  if (state.mode === "edit") {
    return <DashboardBuilder key={state.id} id={state.id} onBack={() => setState({ mode: "report", id: state.id })} onPreview={() => setState({ mode: "report", id: state.id })} />;
  }
  return <DashboardList onOpen={(id) => setState({ mode: "report", id })} />;
}
