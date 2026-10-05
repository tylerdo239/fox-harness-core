// Typed client for the Data Studio chart / dashboard endpoints of services/gateway (same contracts as
// bot-data-studio-api's dashboard routes — docs/data-studio-mongodb-plan.md). Every call goes through
// `runtime.authedFetch`, so an expired token sends the user back to the login screen.
import type { Runtime } from '../../../runtime.ts'
import type { ChartSpec } from '../conversation/ChartView.tsx'

export interface ChartOut {
  id: string
  type: string
  title: string
  description: string
  x: string | null
  y: string[]
  value_field: string | null
  recommended: boolean
  is_pinned: boolean
  title_override: string | null
  x_override: string | null
  y_override: string[] | null
  color_overrides: Record<string, string>
  label_overrides: Record<string, string>
  rows: Record<string, unknown>[]
}

export interface WidgetOut {
  id: string
  seq: number
  kind: string // 'chart' | 'text'
  x: number
  y: number
  w: number
  h: number
  title_override: string | null
  note: string | null
  text: string | null
  config: Record<string, unknown>
  chart: ChartOut | null
}

export interface DashboardSummary {
  id: string
  title: string
  description: string
  widget_count: number
  updated_at: string
}

export interface DashboardDetail {
  id: string
  title: string
  description: string
  appearance: Record<string, string>
  widgets: WidgetOut[]
}

export interface AvailableChart {
  chart_id: string
  type: string
  title: string
  conversation_title: string | null
  chart: ChartOut
}

export interface WidgetLayoutInput {
  id: string | null
  kind: string
  chart_id: string | null
  x: number
  y: number
  w: number
  h: number
  title_override: string | null
  note: string | null
  text: string | null
}

export interface ChartUpdate {
  title_override?: string | null
  x_override?: string | null
  y_override?: string[] | null
  color_overrides?: Record<string, string>
  label_overrides?: Record<string, string>
}

export function chartOutToSpec(chart: ChartOut, titleOverride?: string | null): ChartSpec {
  return {
    chart_id: chart.id,
    type: chart.type,
    title: chart.title,
    description: chart.description,
    x: chart.x,
    y: chart.y,
    value_field: chart.value_field,
    rows: chart.rows,
    recommended: chart.recommended,
    title_override: titleOverride || chart.title_override,
    x_override: chart.x_override,
    y_override: chart.y_override,
    color_overrides: chart.color_overrides,
    label_overrides: chart.label_overrides,
  }
}

async function request<T>(runtime: Runtime, path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const res = await runtime.authedFetch(path, {
    ...rest,
    ...(json !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) } : {}),
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}`)
  return (await res.json()) as T
}

export const dsApi = {
  listDashboards: (rt: Runtime) => request<DashboardSummary[]>(rt, '/data-studio/dashboards'),
  getDashboard: (rt: Runtime, id: string) => request<DashboardDetail>(rt, `/data-studio/dashboards/${id}`),
  createDashboard: (rt: Runtime, input: { title?: string; description?: string }) =>
    request<DashboardDetail>(rt, '/data-studio/dashboards', { method: 'POST', json: input }),
  updateDashboard: (rt: Runtime, id: string, input: { title?: string; description?: string; appearance?: Record<string, string> }) =>
    request<DashboardDetail>(rt, `/data-studio/dashboards/${id}`, { method: 'PATCH', json: input }),
  deleteDashboard: (rt: Runtime, id: string) => request<{ deleted: boolean }>(rt, `/data-studio/dashboards/${id}`, { method: 'DELETE' }),
  pinChart: (rt: Runtime, dashboardId: string, chartId: string) =>
    request<DashboardDetail>(rt, `/data-studio/dashboards/${dashboardId}/charts`, { method: 'POST', json: { chart_id: chartId } }),
  availableCharts: (rt: Runtime) => request<AvailableChart[]>(rt, '/data-studio/dashboards/meta/available-charts'),
  saveWidgets: (rt: Runtime, dashboardId: string, widgets: WidgetLayoutInput[]) =>
    request<DashboardDetail>(rt, `/data-studio/dashboards/${dashboardId}/widgets`, { method: 'PUT', json: { widgets } }),
  updateChart: (rt: Runtime, chartId: string, patch: ChartUpdate) =>
    request<ChartOut>(rt, `/data-studio/charts/${chartId}`, { method: 'PATCH', json: patch }),
}
