// Renders the `chart` field of an `analyze_data` tool result (docs/
// data-studio-agent-transfer-plan.md) — the vendored Python pipeline's own
// shape (`services/data-studio-agent/src/pipeline_v3/orchestrator.py`'s
// `_build_one_chart`): `{type, x, y: string[], title, rows}`. `type` is
// whatever the pipeline's chart agent proposed ("bar" is its own fallback);
// anything this component doesn't recognize also falls back to a bar chart
// rather than rendering nothing.
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface ChartSpec {
  type?: string;
  x?: string | null;
  y?: string[];
  title?: string;
  rows?: Record<string, unknown>[];
}

const COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#a855f7",
];

export function ChartView({ chart }: { chart: ChartSpec }) {
  const rows = chart.rows ?? [];
  const x = chart.x ?? undefined;
  const ys = chart.y ?? [];
  if (rows.length === 0 || !x || ys.length === 0) return null;

  const type = (chart.type ?? "bar").toLowerCase();

  if (type === "pie") {
    const yKey = ys[0];
    return (
      <div className="chart-view">
        {chart.title && <div className="chart-view-title">{chart.title}</div>}
        <ResponsiveContainer width="100%" height={280}>
          <PieChart>
            <Pie data={rows} dataKey={yKey} nameKey={x} outerRadius={100} label>
              {rows.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="chart-view">
      {chart.title && <div className="chart-view-title">{chart.title}</div>}
      <ResponsiveContainer width="100%" height={280}>
        {type === "line" ? (
          <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={x} tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            {ys.length > 1 && <Legend />}
            {ys.map((key, i) => (
              <Line key={key} dataKey={key} stroke={COLORS[i % COLORS.length]} />
            ))}
          </LineChart>
        ) : type === "area" ? (
          <AreaChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={x} tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            {ys.length > 1 && <Legend />}
            {ys.map((key, i) => (
              <Area key={key} dataKey={key} fill={COLORS[i % COLORS.length]} stroke={COLORS[i % COLORS.length]} />
            ))}
          </AreaChart>
        ) : (
          <BarChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={x} tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            {ys.length > 1 && <Legend />}
            {ys.map((key, i) => (
              <Bar key={key} dataKey={key} fill={COLORS[i % COLORS.length]} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
