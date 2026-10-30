// One chart of an `analyze_data` result (docs/data-studio-agent-transfer-plan.md); used by the chat answer
// (DataStudioAnswer.tsx) and the dashboards (DataStudioDashboards.tsx, `chromeless`). The drawing itself is ChartPlot.tsx,
// loaded on first use or when the page is idle (docs/ui-performance-plan.md): until then a box of the same size
// holds the chart's place, so nothing moves when it arrives.
import { lazy, Suspense } from "react";

import { useLocale } from "../../../i18n/locale.tsx";
import { chartTitle, resolveChart, type ChartSpec } from "./chartSpec.ts";

export * from "./chartSpec.ts";

export const loadChartPlot = () => import("./ChartPlot.tsx");
const ChartPlot = lazy(() => loadChartPlot().then((module) => ({ default: module.ChartPlot })));

type ChartViewProps = {
  chart: ChartSpec;
  // pixels, or "100%" to fill a sized parent (dashboard cards)
  height?: number | `${number}%`;
  // just the plot: no title (the dashboard card draws its own)
  chromeless?: boolean;
};

export function ChartView(props: ChartViewProps) {
  return (
    <Suspense fallback={<ChartPlaceholder {...props} />}>
      <ChartPlot {...props} />
    </Suspense>
  );
}

// ChartPlot's outer frame (same classes, title and height), empty.
function ChartPlaceholder({ chart: input, height = 280, chromeless = false }: ChartViewProps) {
  const { t } = useLocale();
  const chart = resolveChart(input);
  if ((chart.rows ?? []).length === 0) return null;
  const fill = height === "100%";
  const titleText = chartTitle(chart, t("conversation.dsTable"));
  return (
    <div className="chart-view w-full" style={fill ? { height: "100%" } : undefined}>
      {!chromeless && titleText ? <div className="chart-view-title [margin-bottom:0.4em] font-medium [font-size:0.9em] [color:var(--muted)]">{titleText}</div> : null}
      <div style={{ height: fill ? "100%" : height }} />
    </div>
  );
}
