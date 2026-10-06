// Copied from bot-data-studio-web-main/src/app/(app)/metrics/page.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Divide,
  Loader2,
  Pencil,
  Plus,
  SearchX,
  Sigma,
  Trash2,
} from "lucide-react";
import { MetricEditor } from "@/components/profile/metric-editor";
import { Badge } from "@/components/ui/badge";
import { ProfileTransfer } from "@/components/profile-transfer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteProfileMetric, getProfileMetrics, setProfileMetricEnabled } from "@/lib/api";
import { AgentToggle } from "@/components/agent-toggle";
import type { MetricItem } from "@/lib/types";

const PAGE_SIZE = 10;
type View = "all" | "aggregate" | "ratio" | "incomplete";

export default function MetricsPage() {
  const [items, setItems] = useState<MetricItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");
  const [page, setPage] = useState(1);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    getProfileMetrics()
      .then(setItems)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load metrics"),
      )
      .finally(() => setLoading(false));
  }, []);

  function handleSaved(saved: MetricItem) {
    const isNew = !items.some((m) => m.id === saved.id);
    // names of ratios may change when a metric they use is renamed: refresh the whole list
    getProfileMetrics()
      .then(setItems)
      .catch(() =>
        setItems((prev) =>
          isNew
            ? [saved, ...prev]
            : prev.map((m) => (m.id === saved.id ? saved : m)),
        ),
      );
    if (isNew) setPage(1);
  }

  async function handleEnabled(id: string, enabled: boolean) {
    const saved = await setProfileMetricEnabled(id, enabled);
    setItems((prev) => prev.map((m) => (m.id === id ? saved : m)));
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteProfileMetric(id);
      setItems((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete metric");
    } finally {
      setConfirmingId(null);
    }
  }

  const isIncomplete = (m: MetricItem) =>
    m.checklist.required_done < m.checklist.required_total;
  const q = query.trim().toLowerCase();
  const shown = items.filter((m) => {
    if (view === "aggregate" && m.kind !== "aggregate") return false;
    if (view === "ratio" && m.kind !== "ratio") return false;
    if (view === "incomplete" && !isIncomplete(m)) return false;
    if (!q) return true;
    return [
      m.name,
      m.display_name,
      m.description ?? "",
      ...m.synonyms,
      m.table?.physical_path ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = shown.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const counts = {
    all: items.length,
    aggregate: items.filter((m) => m.kind === "aggregate").length,
    ratio: items.filter((m) => m.kind === "ratio").length,
    incomplete: items.filter(isIncomplete).length,
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Metrics</h1>
          <p className="text-sm text-muted-foreground">
            Business numbers people ask about, defined once so every answer
            counts them the same way.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProfileTransfer
            what="metrics"
            exportPath="/data-profile/metrics/export.json"
            importPath="/data-profile/metrics/import"
            fileName="metrics.json"
            onImported={() => void getProfileMetrics().then(setItems).catch(() => {})}
          />
          <MetricEditor
            metrics={items}
            onSaved={handleSaved}
            trigger={
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New metric
              </Button>
            }
          />
        </div>
      </div>

      {!loading && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search metrics"
            className="h-8 max-w-xs text-sm"
          />
          {(
            [
              ["all", `All (${counts.all})`],
              ["aggregate", `Aggregates (${counts.aggregate})`],
              ["ratio", `Ratios (${counts.ratio})`],
              ["incomplete", `Missing required (${counts.incomplete})`],
            ] as [View, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setView(value);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${
                view === value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <p className="whitespace-pre-line text-sm text-destructive">{error}</p>
      )}
      {!loading && items.length === 0 && (
        <p className="text-muted-foreground">
          No metrics yet. Start with the numbers people ask about most, e.g.
          revenue or number of conversations.
        </p>
      )}
      {!loading && items.length > 0 && shown.length === 0 && (
        <p className="text-sm text-muted-foreground">No metrics match.</p>
      )}

      {pageItems.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Metric</th>
                <th className="px-3 py-2">Calculates</th>
                <th className="px-3 py-2">Unit</th>
                <th className="px-3 py-2">Status</th>
                <th className="w-28 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {pageItems.map((m) => {
                const missing =
                  m.checklist.required_total - m.checklist.required_done;
                return (
                  <tr key={m.id} className={`border-t align-top ${m.disabled ? "bg-muted/40 [&>td:not(:last-child)]:opacity-60" : ""}`}>
                    <td className="px-3 py-2">
                      <div className="font-mono text-sm font-semibold text-primary">
                        {m.name}
                      </div>
                      <div className="font-medium">{m.display_name}</div>
                      {m.description && (
                        <div className="line-clamp-2 max-w-sm text-xs text-muted-foreground">
                          {m.description}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {m.kind === "ratio" ? (
                          <Divide className="h-3.5 w-3.5" />
                        ) : (
                          <Sigma className="h-3.5 w-3.5" />
                        )}
                        {m.kind === "ratio" ? "Ratio" : "Aggregate"}
                        {m.table && (
                          <span className="inline-flex items-center gap-1">
                            · <Database className="h-3 w-3" />{" "}
                            {m.table.data_source_name}
                          </span>
                        )}
                      </div>
                      {m.table && (
                        <div className="break-all font-mono text-xs font-semibold text-primary">
                          {m.table.physical_path}
                        </div>
                      )}
                      <div className="mt-0.5 max-w-md break-words font-mono text-xs">
                        {m.formula}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">
                      {m.unit ?? "—"}
                      {m.additive === "none" && (
                        <div className="text-muted-foreground">
                          not summable
                        </div>
                      )}
                      {m.additive === "not_time" && (
                        <div className="text-muted-foreground">
                          not across time
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-start gap-1">
                        {m.disabled && <Badge variant="outline">Disabled</Badge>}
                        {missing > 0 ? (
                          <Badge variant="destructive">{missing} missing</Badge>
                        ) : (
                          <Badge variant="secondary">ok</Badge>
                        )}
                        {m.search_index.status &&
                          m.search_index.status !== "ok" && (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
                              title={m.search_index.error ?? undefined}
                            >
                              <SearchX className="h-3 w-3" /> not indexed — save
                              again
                            </span>
                          )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {confirmingId === m.id ? (
                        <div className="flex items-center gap-1 text-xs">
                          Delete?
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 px-2"
                            onClick={() => handleDelete(m.id)}
                          >
                            Yes
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={() => setConfirmingId(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <AgentToggle
                            enabled={!m.disabled}
                            onChange={(on) => handleEnabled(m.id, on)}
                            label={`metric ${m.name}`}
                            className="mr-1"
                          />
                          <MetricEditor
                            metric={m}
                            metrics={items}
                            onSaved={handleSaved}
                            trigger={
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Edit ${m.name}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setConfirmingId(m.id)}
                            aria-label={`Delete ${m.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {shown.length > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="tabular-nums text-muted-foreground">
            {(currentPage - 1) * PAGE_SIZE + 1}–
            {Math.min(currentPage * PAGE_SIZE, shown.length)} of {shown.length}
          </span>
          <nav className="flex items-center gap-1" aria-label="Pages">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-2 tabular-nums">
              {currentPage} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage === pageCount}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </nav>
        </div>
      )}
    </div>
  );
}
