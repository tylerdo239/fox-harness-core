// docs/data-studio-admin-ui-plan.md — Dashboards section (Phase 3, part 5,
// the last one). No drag/resize grid builder for this pass — widgets render
// as a plain vertical list in `seq` order, reordered via up/down buttons
// (see data-studio-db.ts's `moveWidget`'s own comment for why). A widget's
// chart data comes pre-joined from GET /data-studio/dashboards/:id
// (data-studio-db.ts's `listWidgets`) — no separate fetch per chart needed.
import { useCallback, useEffect, useState } from "react";

import { ArrowLeftIcon, TrashIcon } from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";
import { Input } from "../../primitives/Input.tsx";
import { ChartView, type ChartSpec } from "../conversation/ChartView.tsx";

interface Dashboard {
  id: number;
  title: string;
  description: string;
}

interface Widget {
  id: number;
  dashboard_id: number;
  seq: number;
  chart_id: number | null;
  chart_type: string | null;
  chart_title: string | null;
  chart_x: string | null;
  chart_y: string | null;
  chart_rows: string | null;
}

function widgetChartSpec(widget: Widget): ChartSpec {
  let y: string[] = [];
  let rows: Record<string, unknown>[] = [];
  try {
    y = JSON.parse(widget.chart_y ?? "[]");
  } catch {
    // leave empty
  }
  try {
    rows = JSON.parse(widget.chart_rows ?? "[]");
  } catch {
    // leave empty
  }
  return { type: widget.chart_type ?? "bar", x: widget.chart_x, y, rows, title: widget.chart_title ?? "" };
}

export function DataStudioDashboards() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState("");

  const loadDashboards = useCallback(async () => {
    setLoading(true);
    const res = await runtime.authedFetch("/data-studio/dashboards");
    if (res.ok) setDashboards(await res.json());
    setLoading(false);
  }, [runtime]);

  useEffect(() => {
    void loadDashboards();
  }, [loadDashboards]);

  const loadDetail = useCallback(
    async (id: number) => {
      const res = await runtime.authedFetch(`/data-studio/dashboards/${id}`);
      if (res.ok) setWidgets((await res.json()).widgets ?? []);
    },
    [runtime],
  );

  async function createDashboard(): Promise<void> {
    if (!newTitle.trim()) return;
    const res = await runtime.authedFetch("/data-studio/dashboards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: newTitle.trim() }),
    });
    if (res.ok) {
      setNewTitle("");
      await loadDashboards();
    }
  }

  async function deleteDashboard(dashboard: Dashboard): Promise<void> {
    const res = await runtime.authedFetch(`/data-studio/dashboards/${dashboard.id}`, { method: "DELETE" });
    if (res.ok) await loadDashboards();
  }

  async function removeWidget(widget: Widget): Promise<void> {
    const res = await runtime.authedFetch(`/data-studio/dashboards/${widget.dashboard_id}/widgets/${widget.id}`, { method: "DELETE" });
    if (res.ok && selectedId !== null) await loadDetail(selectedId);
  }

  async function moveWidget(widget: Widget, direction: "up" | "down"): Promise<void> {
    const res = await runtime.authedFetch(`/data-studio/dashboards/${widget.dashboard_id}/widgets/${widget.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction }),
    });
    if (res.ok && selectedId !== null) await loadDetail(selectedId);
  }

  if (loading) return <div className="fh-data-studio-loading">{t("dataStudio.loading")}</div>;

  const selected = dashboards.find((d) => d.id === selectedId) ?? null;

  if (selected) {
    return (
      <div className="fh-data-studio-admin">
        <button
          type="button"
          className="fh-data-studio-crumb-back"
          onClick={() => {
            setSelectedId(null);
            setWidgets([]);
          }}
        >
          <ArrowLeftIcon size={14} /> {selected.title}
        </button>
        {widgets.length === 0 ? (
          <p className="fh-data-studio-empty">{t("dataStudio.noWidgets")}</p>
        ) : (
          <div className="fh-data-studio-widget-list">
            {widgets.map((widget, index) => (
              <div key={widget.id} className="fh-data-studio-widget">
                <div className="fh-data-studio-widget-toolbar">
                  <IconButton onClick={() => moveWidget(widget, "up")} disabled={index === 0} title={t("dataStudio.moveUp")}>
                    ↑
                  </IconButton>
                  <IconButton onClick={() => moveWidget(widget, "down")} disabled={index === widgets.length - 1} title={t("dataStudio.moveDown")}>
                    ↓
                  </IconButton>
                  <IconButton onClick={() => removeWidget(widget)} title={t("dataStudio.removeWidget")}>
                    <TrashIcon size={14} />
                  </IconButton>
                </div>
                <ChartView chart={widgetChartSpec(widget)} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fh-data-studio-admin">
      <div className="fh-data-studio-admin-header">
        <h2>{t("dataStudio.sectionDashboards")}</h2>
      </div>

      <div className="fh-data-studio-add-form">
        <Input
          placeholder={t("dataStudio.dashboardTitlePlaceholder")}
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <Button variant="primary" onClick={createDashboard} disabled={!newTitle.trim()}>
          {t("dataStudio.newDashboardButton")}
        </Button>
      </div>

      {dashboards.length === 0 ? (
        <p className="fh-data-studio-empty">{t("dataStudio.noDashboards")}</p>
      ) : (
        <table className="fh-data-studio-table">
          <tbody>
            {dashboards.map((dashboard) => (
              <tr key={dashboard.id}>
                <td>
                  <Button
                    variant="link"
                    onClick={() => {
                      setSelectedId(dashboard.id);
                      void loadDetail(dashboard.id);
                    }}
                  >
                    {dashboard.title}
                  </Button>
                </td>
                <td>
                  <IconButton onClick={() => deleteDashboard(dashboard)} title={t("dataStudio.deleteDashboard")}>
                    <TrashIcon size={14} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
