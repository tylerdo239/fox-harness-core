// Draws one chart of an `analyze_data` result (docs/data-studio-agent-transfer-plan.md) — the vendored
// Python pipeline's own shape (`pipeline_v3/orchestrator.py`'s `_build_one_chart`) plus the user's saved edits.
// A port of the reference chart-view (examples/bot-data-studio-web-main components/chat/chart-view.tsx): line | area |
// stacked_area | bar | bar_horizontal | stacked_bar | combo | pie | donut | treemap | scatter | stat | table, per-field
// label overrides, per-series color overrides, Y-axis titles. Used by the chat answer
// (DataStudioAnswer.tsx) and by the dashboard report / builder (DataStudioDashboards.tsx, `chromeless`).
// Loaded on demand by ChartView.tsx (recharts is ~330 KB): import ChartView, not this file.
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Label,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { useLocale } from "../../../i18n/locale.tsx";
import { SERIES_COLORS, categoryOf, chartTitle, colorFor, labelFor, resolveChart, toNumber, type ChartSpec } from "./chartSpec.ts";

function TreemapCell(props: { x?: number; y?: number; width?: number; height?: number; index?: number; name?: string; depth?: number }) {
  const { x = 0, y = 0, width = 0, height = 0, index = 0, name = "", depth = 1 } = props;
  if (depth === 0) return null;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={SERIES_COLORS[index % SERIES_COLORS.length]} stroke="#fff" strokeWidth={2} />
      {width > 60 && height > 22 && (
        <text x={x + 6} y={y + 16} fill="#fff" fontSize={11}>
          {name.length > width / 7 ? `${name.slice(0, Math.max(1, Math.floor(width / 7) - 1))}…` : name}
        </text>
      )}
    </g>
  );
}

// Animations are off everywhere: charts repaint on every edit, and a print/PDF taken mid-animation would show
// half-drawn bars and slices.
const AXIS_LABEL = { fill: "var(--muted)", fontSize: 12 } as const;
const TOOLTIP_STYLE = { fontSize: 12, borderRadius: 8 } as const;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString() : String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function ChartPlot({
  chart: input,
  height = 280,
  chromeless = false,
}: {
  chart: ChartSpec;
  // pixels, or "100%" to fill a sized parent (dashboard cards)
  height?: number | `${number}%`;
  // just the plot: no title (the dashboard card draws its own)
  chromeless?: boolean;
}) {
  const { t } = useLocale();
  const chart = resolveChart(input);
  const rows = chart.rows ?? [];
  const type = (chart.type ?? "bar").toLowerCase();
  const label = (field: string) => labelFor(field, chart.label_overrides);
  const fill = height === "100%";
  const wrapStyle = fill ? { height: "100%" } : undefined;
  const titleText = chartTitle(chart, t("conversation.dsTable"));
  const title = !chromeless && titleText ? <div className="chart-view-title [margin-bottom:0.4em] font-medium [font-size:0.9em] [color:var(--muted)]">{titleText}</div> : null;

  if (rows.length === 0) return null;

  if (type === "stat") {
    const field = chart.value_field ?? chart.y?.[0] ?? Object.keys(rows[0] ?? {})[0];
    const value = field ? rows[0]?.[field] : undefined;
    return (
      <div className="chart-view w-full" style={wrapStyle}>
        {title}
        <div className="ds-stat flex flex-col items-center justify-center [gap:4px] [min-height:160px] h-full" style={fill ? undefined : { height }}>
          <div className="ds-stat-value [font-size:3rem] font-bold [font-variant-numeric:tabular-nums]">{value === null || value === undefined ? "—" : formatCell(value)}</div>
          <div className="ds-stat-label [color:var(--muted)] [font-size:0.9em]">{field ? label(field) : ""}</div>
        </div>
      </div>
    );
  }

  if (type === "table") {
    const columns = chart.y && chart.y.length > 0 ? chart.y : Object.keys(rows[0] ?? {});
    return (
      <div className="chart-view w-full" style={wrapStyle}>
        {title}
        <div className="ds-table-wrap [max-height:360px] overflow-auto [border:1px_solid_var(--border-subtle)] [border-radius:var(--radius-md)]" style={fill ? { height: "100%", maxHeight: "none" } : undefined}>
          <table className="ds-table w-full [border-collapse:collapse] [font-size:0.85em] [&_th]:sticky [&_th]:[top:0] [&_th]:[padding:6px_10px] [&_th]:[background:var(--surface)] [&_th]:font-semibold [&_th]:text-left [&_th]:whitespace-nowrap [&_td]:[max-width:320px] [&_td]:[padding:5px_10px] [&_td]:[border-top:1px_solid_var(--border-subtle)] [&_td]:overflow-hidden [&_td]:text-ellipsis [&_td]:whitespace-nowrap">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{label(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c} title={typeof row[c] === "string" ? (row[c] as string) : undefined}>
                      {formatCell(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const x = chart.x ?? undefined;
  const ys = chart.y ?? [];
  if (!x || ys.length === 0) return null;

  // y values may arrive as numeric strings (Dremio decimals) — plot them as numbers.
  const data = rows.map((row) => {
    const point: Record<string, unknown> = { [x]: categoryOf(row[x]) };
    for (const y of ys) point[y] = toNumber(row[y]) ?? row[y];
    return point;
  });
  // a single series names the Y axis; several use a legend, so a generic title reads best
  const yTitle = ys.length === 1 ? label(ys[0]) : "";
  const margin = { top: 8, right: 16, left: 12, bottom: 24 };
  const tooltip = <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(v) => `${label(x)}: ${v}`} />;

  const xAxis = (
    <XAxis dataKey={x} tick={{ fontSize: 11 }}>
      <Label value={label(x)} position="insideBottom" offset={-14} style={AXIS_LABEL} />
    </XAxis>
  );
  const yAxis = (
    <YAxis tick={{ fontSize: 11 }}>
      {yTitle && <Label value={yTitle} angle={-90} position="insideLeft" style={{ ...AXIS_LABEL, textAnchor: "middle" }} />}
    </YAxis>
  );

  let plot: React.ReactElement;
  if (type === "pie" || type === "donut") {
    // Share of one measure across categories: x = category, y[0] = value.
    plot = (
      <PieChart>
        {tooltip}
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Pie isAnimationActive={false} data={data} dataKey={ys[0]} nameKey={x} cx="50%" cy="50%" outerRadius="70%" innerRadius={type === "donut" ? "45%" : 0} label={(e: { name?: string }) => e.name ?? ""}>
          {data.map((_, i) => (
            <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
          ))}
        </Pie>
      </PieChart>
    );
  } else if (type === "treemap") {
    // Share of one measure as nested rectangles: x = category, y[0] = size (non-positive values left out).
    const cells = rows
      .map((row) => ({ name: String(row[x] ?? "—"), size: toNumber(row[ys[0]]) ?? 0 }))
      .filter((c) => c.size > 0);
    plot = (
      <Treemap data={cells} dataKey="size" nameKey="name" isAnimationActive={false} content={<TreemapCell />}>
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [String(v), label(ys[0])]} />
      </Treemap>
    );
  } else if (type === "scatter") {
    const points = rows
      .map((row) => ({ x: toNumber(row[x]), y: toNumber(row[ys[0]]) }))
      .filter((p) => p.x !== null && p.y !== null);
    plot = (
      <ScatterChart margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
        <XAxis type="number" dataKey="x" name={label(x)} tick={{ fontSize: 11 }}>
          <Label value={label(x)} position="insideBottom" offset={-14} style={AXIS_LABEL} />
        </XAxis>
        <YAxis type="number" dataKey="y" name={label(ys[0])} tick={{ fontSize: 11 }}>
          <Label value={label(ys[0])} angle={-90} position="insideLeft" style={{ ...AXIS_LABEL, textAnchor: "middle" }} />
        </YAxis>
        <ZAxis range={[50, 50]} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Scatter isAnimationActive={false} data={points} fill={colorFor(chart, ys[0], 0)} />
      </ScatterChart>
    );
  } else if (type === "line") {
    plot = (
      <LineChart data={data} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
        {xAxis}
        {yAxis}
        {tooltip}
        {ys.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {ys.map((key, i) => (
          <Line key={key} isAnimationActive={false} type="monotone" dataKey={key} name={label(key)} stroke={colorFor(chart, key, i)} strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    );
  } else if (type === "area" || type === "stacked_area") {
    const stackId = type === "stacked_area" ? "s" : undefined;
    plot = (
      <AreaChart data={data} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
        {xAxis}
        {yAxis}
        {tooltip}
        {ys.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {ys.map((key, i) => (
          <Area key={key} isAnimationActive={false} type="monotone" stackId={stackId} dataKey={key} name={label(key)} fill={colorFor(chart, key, i)} stroke={colorFor(chart, key, i)} />
        ))}
      </AreaChart>
    );
  } else if (type === "combo") {
    // y[0] as bars on the left axis, y[1] as a line on its own right axis (different scales)
    const [barField, lineField] = ys;
    plot = (
      <ComposedChart data={data} margin={{ ...margin, right: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
        {xAxis}
        <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
        {tooltip}
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {barField && <Bar yAxisId="left" isAnimationActive={false} dataKey={barField} name={label(barField)} fill={colorFor(chart, barField, 0)} radius={[3, 3, 0, 0]} />}
        {lineField && <Line yAxisId="right" isAnimationActive={false} type="monotone" dataKey={lineField} name={label(lineField)} stroke={colorFor(chart, lineField, 1)} strokeWidth={2} />}
      </ComposedChart>
    );
  } else if (type === "bar_horizontal") {
    // one row per group, names on the left: long names and rankings read well; tall lists scroll
    const rowsHeight = Math.max(240, data.length * 28 + 40);
    return (
      <div className="chart-view w-full" style={wrapStyle}>
        {title}
        <div style={{ height: fill ? "100%" : height, overflowY: "auto" }}>
          <div style={{ height: rowsHeight }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ top: 8, right: 24, bottom: 24, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis type="number" tick={{ fontSize: 11 }}>
                  {yTitle && <Label value={yTitle} position="insideBottom" offset={-14} style={AXIS_LABEL} />}
                </XAxis>
                <YAxis type="category" dataKey={x} width={140} tick={{ fontSize: 11 }} interval={0} />
                {tooltip}
                {ys.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
                {ys.map((key, i) => (
                  <Bar key={key} isAnimationActive={false} dataKey={key} name={label(key)} fill={colorFor(chart, key, i)} radius={[0, 3, 3, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    );
  } else {
    // bar and stacked_bar
    const stackId = type === "stacked_bar" ? "s" : undefined;
    plot = (
      <BarChart data={data} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
        {xAxis}
        {yAxis}
        {tooltip}
        {ys.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {ys.map((key, i) => (
          <Bar key={key} isAnimationActive={false} stackId={stackId} dataKey={key} name={label(key)} fill={colorFor(chart, key, i)} radius={stackId ? undefined : [3, 3, 0, 0]} />
        ))}
      </BarChart>
    );
  }

  return (
    <div className="chart-view w-full" style={wrapStyle}>
      {title}
      <div style={fill ? { height: "100%" } : undefined}>
        <ResponsiveContainer width="100%" height={height}>
          {plot}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
