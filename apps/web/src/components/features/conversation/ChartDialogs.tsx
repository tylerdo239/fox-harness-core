// The three chart dialogs of the reference Data Studio UI (examples/example-data-studio-agent chart-view.tsx):
// "Edit fields" (title, X axis, Y series, labels), "Edit colors" (one color per series) and "Thêm vào dashboard"
// (pick an existing dashboard or create one, then pin the chart). Edits are applied locally by the caller and
// persisted through PATCH /data-studio/charts/:id (dsApi.updateChart).
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { Input } from "../../primitives/Input.tsx";
import { Modal } from "../../primitives/Modal.tsx";
import { dsApi, type DashboardSummary } from "../data-studio/dsApi.ts";
import { colorFor, labelFor, resolveChart, toNumber, type ChartSpec } from "./ChartView.tsx";

export function EditFieldsDialog({
  open,
  onClose,
  spec: input,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  spec: ChartSpec;
  onApply: (title: string, x: string, y: string[], labelOverrides: Record<string, string>) => void;
}) {
  const { t } = useLocale();
  const spec = resolveChart(input);
  const rows = spec.rows ?? [];
  const allColumns = Object.keys(rows[0] ?? {});
  const numericColumns = allColumns.filter((c) => toNumber(rows[0]?.[c]) !== null);

  const [title, setTitle] = useState(spec.title ?? "");
  const [x, setX] = useState(spec.x ?? "");
  const [y, setY] = useState<string[]>(spec.y ?? []);
  // per-field custom labels (field -> label); seeded from the chart's saved overrides
  const [labels, setLabels] = useState<Record<string, string>>({});

  // reseed each time the dialog opens
  useEffect(() => {
    if (!open) return;
    setTitle(spec.title ?? "");
    setX(spec.x ?? "");
    setY(spec.y ?? []);
    setLabels({ ...(spec.label_overrides ?? {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleY = (column: string) =>
    setY((prev) => (prev.includes(column) ? prev.filter((c) => c !== column) : [...prev, column]));
  // the label shown in an input: the pending override, else the field name
  const labelValue = (field: string) => labels[field] ?? "";
  // only keep overrides that actually differ from the default (keeps storage clean)
  const cleanedOverrides = () => {
    const out: Record<string, string> = {};
    for (const field of [x, ...y]) {
      const value = (labels[field] ?? "").trim();
      if (value && value !== field) out[field] = value;
    }
    return out;
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("dsx.fieldsTitle")}
      description={t("dsx.fieldsDesc")}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("dsx.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!title.trim() || !x || y.length === 0}
            onClick={() => {
              onApply(title.trim(), x, y, cleanedOverrides());
              onClose();
            }}
          >
            {t("dsx.apply")}
          </Button>
        </>
      }
    >
      <div className="ds-form">
        <label className="ds-field">
          <span>{t("dsx.chartName")}</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="ds-field">
          <span>{t("dsx.xAxis")}</span>
          <div className="ds-field-row">
            <select value={x} onChange={(e) => setX(e.target.value)}>
              {allColumns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <Input value={labelValue(x)} onChange={(e) => setLabels((p) => ({ ...p, [x]: e.target.value }))} placeholder={t("dsx.axisLabel")} />
          </div>
        </div>
        <div className="ds-field">
          <span>{t("dsx.ySeries")}</span>
          {numericColumns.map((column) => {
            const on = y.includes(column);
            return (
              <div key={column} className="ds-field-row">
                <label className="ds-check">
                  <input type="checkbox" checked={on} onChange={() => toggleY(column)} />
                  {column}
                </label>
                {on && (
                  <Input
                    value={labelValue(column)}
                    onChange={(e) => setLabels((p) => ({ ...p, [column]: e.target.value }))}
                    placeholder={t("dsx.seriesLabel")}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

export function EditColorsDialog({
  open,
  onClose,
  spec: input,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  spec: ChartSpec;
  onApply: (colors: Record<string, string>) => void;
}) {
  const { t } = useLocale();
  const spec = resolveChart(input);
  // the series a chart colors: its y fields (or the single stat/value field)
  const fields = spec.type === "stat" ? [spec.value_field ?? spec.y?.[0] ?? ""].filter(Boolean) : (spec.y ?? []);
  const [colors, setColors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const initial: Record<string, string> = {};
    fields.forEach((f, i) => (initial[f] = colorFor(spec, f, i)));
    setColors(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("dsx.colorsTitle")}
      description={t("dsx.colorsDesc")}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("dsx.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onApply(colors);
              onClose();
            }}
          >
            {t("dsx.apply")}
          </Button>
        </>
      }
    >
      <div className="ds-form">
        {fields.map((field, i) => (
          <div key={field} className="ds-field-row ds-color-row">
            <span>{labelFor(field, spec.label_overrides)}</span>
            <input
              type="color"
              value={colors[field] ?? colorFor(spec, field, i)}
              onChange={(e) => setColors((prev) => ({ ...prev, [field]: e.target.value }))}
            />
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function AddToDashboardDialog({ open, onClose, chartId }: { open: boolean; onClose: () => void; chartId: string }) {
  const { t } = useLocale();
  const runtime = useRuntime();
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");

  useEffect(() => {
    if (!open) return;
    setDone(null);
    setNewTitle("");
    setLoading(true);
    dsApi
      .listDashboards(runtime)
      .then(setDashboards)
      .catch(() => setDashboards([]))
      .finally(() => setLoading(false));
  }, [open, runtime]);

  async function pinTo(dashboardId: string, name: string): Promise<void> {
    setBusy(true);
    try {
      await dsApi.pinChart(runtime, dashboardId, chartId);
      setDone(name);
    } catch {
      toast.error(t("conversation.pinFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createAndPin(): Promise<void> {
    setBusy(true);
    try {
      const created = await dsApi.createDashboard(runtime, { title: newTitle.trim() || undefined });
      await dsApi.pinChart(runtime, created.id, chartId);
      setDone(created.title);
    } catch {
      toast.error(t("conversation.pinFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("dsx.addToDashboard")}
      description={t("dsx.pickDashboard")}
      footer={done ? <Button variant="primary" onClick={onClose}>{t("dsx.close")}</Button> : undefined}
    >
      {done ? (
        <p>{t("dsx.addedTo", { name: done })}</p>
      ) : (
        <div className="ds-form">
          <div className="ds-field">
            <span>{t("dsx.existingDashboards")}</span>
            {loading ? (
              <div className="ds-muted">{t("dataStudio.loading")}</div>
            ) : dashboards.length === 0 ? (
              <div className="ds-muted">{t("dsx.noDashboards")}</div>
            ) : (
              <div className="ds-pick-list">
                {dashboards.map((d) => (
                  <button key={d.id} type="button" className="ds-pick" disabled={busy} onClick={() => void pinTo(d.id, d.title)}>
                    <span>{d.title}</span>
                    <span className="ds-muted">{t("dsx.chartsCount", { n: String(d.widget_count) })}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="ds-field ds-field-divided">
            <span>{t("dsx.createNewDashboard")}</span>
            <div className="ds-field-row">
              <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t("dsx.dashboardNamePlaceholder")} />
              <Button variant="primary" disabled={busy} onClick={() => void createAndPin()}>
                {t("dsx.create")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
