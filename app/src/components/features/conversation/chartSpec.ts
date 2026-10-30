// The chart spec of an `analyze_data` result and the helpers that don't draw anything (no recharts), split out of
// ChartView.tsx so the chat can use them without loading the chart library (docs/ui-performance-plan.md).

export interface ChartSpec {
  type?: string;
  x?: string | null;
  y?: string[];
  title?: string;
  description?: string;
  rows?: Record<string, unknown>[];
  recommended?: boolean;
  value_field?: string | null;
  // The persisted `charts` document id (uuid) — present once bridge/runner.py saved the chart, which is what
  // lets the UI edit it (PATCH /data-studio/charts/:id) and pin it to a dashboard.
  chart_id?: string | null;
  // The user's saved edits ("Edit fields" / "Edit colors"): folded over the recommended spec by resolveChart().
  title_override?: string | null;
  x_override?: string | null;
  y_override?: string[] | null;
  color_overrides?: Record<string, string>;
  label_overrides?: Record<string, string>;
}

// Series palette shared by every chart: the app's orange first (public/theme.css --fh-accent), then hues far from it
// (the reference UI's amber is dropped — next to orange two series were hard to tell apart).
export const SERIES_COLORS = ["#ff7a1f", "#3b82f6", "#10b981", "#8b5cf6", "#ef4444", "#14b8a6"];

// Every chart type, in the order the type picker shows them.
export const CHART_TYPES = [
  "line", "area", "stacked_area", "bar", "bar_horizontal", "stacked_bar", "combo",
  "pie", "donut", "treemap", "scatter", "stat", "table",
] as const;

// Types whose X / Y fields the user can re-pick ("Edit fields"); the rest are shaped by their data.
export const EDITABLE_CHART_TYPES: readonly string[] = ["line", "area", "stacked_area", "bar", "bar_horizontal", "stacked_bar", "combo", "scatter"];

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return null;
}

// An X value as the category recharts can draw: it only places string / number keys, so a boolean (`is_active`),
// a null or an object would leave the plot empty.
export function categoryOf(value: unknown): string | number {
  if (typeof value === "number" || typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// Charts saved by pipeline v3 before 2026-10-08 name the raw-rows table "Bảng dữ liệu" whatever the question's
// language: show the UI's own label for it.
export function chartTitle(chart: { type?: string | null; title?: string | null }, tableLabel: string): string {
  return (chart.type ?? "").toLowerCase() === "table" && chart.title === "Bảng dữ liệu" ? tableLabel : chart.title ?? "";
}

// A saved chart already carries its persisted edits; fold them into the working spec so the chart renders the
// user's last-chosen title / fields on reload.
export function resolveChart(spec: ChartSpec): ChartSpec {
  return {
    ...spec,
    title: spec.title_override || spec.title,
    x: spec.x_override ?? spec.x,
    y: spec.y_override && spec.y_override.length > 0 ? spec.y_override : spec.y,
  };
}

// The label shown for a data field: the user's override, else the field name itself.
export function labelFor(field: string, overrides?: Record<string, string>): string {
  return overrides?.[field] || field;
}

// The color a series field resolves to: the user's override, else its position in the palette.
export function colorFor(spec: ChartSpec, field: string, i: number): string {
  return spec.color_overrides?.[field] ?? SERIES_COLORS[i % SERIES_COLORS.length];
}
