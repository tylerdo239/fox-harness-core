// Copied from bot-data-studio-web-main/src/app/(app)/data-sources/[id]/page.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Eye, FileDown, Loader2, RefreshCw, Table2 } from "lucide-react";
import { EditEntityDialog } from "@/components/edit-entity-dialog";
import { Badge } from "@/components/ui/badge";
import { ProfileTransfer } from "@/components/profile-transfer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { downloadDataSourceDocx, getEntities, getEntityProfileSummaries, reindexDataSourceProfiles } from "@/lib/api";
import type { Entity, EntityProfileSummary } from "@/lib/types";

type StatusFilter = "all" | "todo" | "needs_review" | "reviewed";

function statusOf(s: EntityProfileSummary | undefined): Exclude<StatusFilter, "all"> {
  if (!s) return "todo";
  if (s.review.needs_review) return "needs_review";
  if (s.review.reviewed_at) return "reviewed";
  return "todo";
}

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "todo", label: "Not reviewed" },
  { value: "needs_review", label: "Changed in Dremio" },
  { value: "reviewed", label: "Reviewed" },
];

export default function DataSourceDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const { id: dataSourceId } = params;

  const [entities, setEntities] = useState<Entity[]>([]);
  const [summaries, setSummaries] = useState<Map<string, EntityProfileSummary>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [rebuilding, setRebuilding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      await downloadDataSourceDocx(dataSourceId, dataSourceId);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }
  const [rebuildMessage, setRebuildMessage] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getEntities(dataSourceId), getEntityProfileSummaries(dataSourceId)])
      .then(([ents, sums]) => {
        setEntities(ents);
        setSummaries(new Map(sums.map((s) => [s.entity_id, s])));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load tables"))
      .finally(() => setLoading(false));
  }, [dataSourceId]);

  function reload() {
    Promise.all([getEntities(dataSourceId), getEntityProfileSummaries(dataSourceId)])
      .then(([ents, sums]) => {
        setEntities(ents);
        setSummaries(new Map(sums.map((s) => [s.entity_id, s])));
      })
      .catch(() => {});
  }

  async function handleRebuild() {
    setRebuilding(true);
    setRebuildMessage(null);
    try {
      const r = await reindexDataSourceProfiles(dataSourceId);
      setRebuildMessage(
        r.stale === 0
          ? `Search index rebuilt for ${r.tables} tables.`
          : `Rebuilt ${r.ok} of ${r.tables} tables; ${r.stale} failed — open them to see why and retry.`,
      );
      const sums = await getEntityProfileSummaries(dataSourceId);
      setSummaries(new Map(sums.map((x) => [x.entity_id, x])));
    } catch (err) {
      setRebuildMessage(err instanceof Error ? err.message : "Rebuild failed");
    } finally {
      setRebuilding(false);
    }
  }

  const notIndexed = entities.filter((e) => summaries.get(e.id)?.search_index.status !== "ok").length;

  function handleEntityUpdated(updated: Entity) {
    setEntities((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
  }

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: entities.length, todo: 0, needs_review: 0, reviewed: 0 };
    for (const e of entities) c[statusOf(summaries.get(e.id))] += 1;
    return c;
  }, [entities, summaries]);

  const visible = entities.filter((e) => {
    const q = query.trim().toLowerCase();
    const matches =
      !q || e.display_name.toLowerCase().includes(q) || e.physical_name.toLowerCase().includes(q);
    const status = statusOf(summaries.get(e.id));
    return matches && (statusFilter === "all" || status === statusFilter);
  });

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <div>
        <Link
          href="/data-sources"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Data Sources
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Tables</h1>
          {entities.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
            <ProfileTransfer
              what="tables and columns"
              exportPath={`/data-profile/data-sources/${dataSourceId}/export.json`}
              importPath={`/data-profile/data-sources/${dataSourceId}/import`}
              fileName={`tables-${dataSourceId}.json`}
              onImported={reload}
            />
            <Button
              variant="outline"
              onClick={() => void handleExport()}
              disabled={exporting}
              title="Tables, columns, relationships, metrics and glossary as a Word file (in Vietnamese) for a data engineer to fill in"
            >
              {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
              Export for DE (.docx)
            </Button>
            <Button variant="outline" onClick={handleRebuild} disabled={rebuilding}>
              {rebuilding ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {rebuilding ? "Rebuilding search index…" : "Rebuild search index"}
            </Button>
            </div>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Open a table to fill in its profile. Everything is entered by people; nothing is read from
          the data. Saved changes go into the agent&apos;s search index automatically
          {notIndexed > 0 && !loading && `; ${notIndexed} table${notIndexed > 1 ? "s are" : " is"} not indexed yet`}.
        </p>
        {rebuildMessage && <p className="mt-2 text-sm">{rebuildMessage}</p>}
        {exportError && <p className="mt-2 text-sm text-destructive">{exportError}</p>}
      </div>

      {!loading && entities.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tables"
            className="max-w-xs"
          />
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatusFilter(f.value)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  statusFilter === f.value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "hover:bg-accent"
                }`}
              >
                {f.label} ({counts[f.value]})
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && !error && entities.length === 0 && (
        <p className="text-muted-foreground">No tables synced for this source.</p>
      )}

      {!loading && entities.length > 0 && visible.length === 0 && (
        <p className="text-sm text-muted-foreground">No tables match.</p>
      )}

      {!loading && visible.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((entity) => {
            const s = summaries.get(entity.id);
            const status = statusOf(s);
            const href = `/data-sources/${dataSourceId}/entities/${entity.id}`;
            const pct = s && s.required_total > 0 ? Math.round((s.required_done / s.required_total) * 100) : 0;
            return (
              <Card key={entity.id} className="h-full transition-colors hover:bg-accent/50">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                  <Link href={href} className="flex min-w-0 flex-1 items-center gap-2">
                    {entity.entity_type === "table" ? (
                      <Table2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="flex min-w-0 flex-col">
                      <span
                        className="truncate font-mono text-sm font-semibold text-primary"
                        title={entity.physical_name}
                      >
                        {entity.physical_name}
                      </span>
                      <CardTitle className="truncate text-base">{entity.display_name}</CardTitle>
                    </div>
                  </Link>
                  <div className="flex items-center gap-1">
                    <EditEntityDialog entity={entity} onUpdated={handleEntityUpdated} />
                    <Link href={href} aria-label={`Open ${entity.display_name}`}>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </Link>
                  </div>
                </CardHeader>
                <Link href={href}>
                  <CardContent className="flex flex-col gap-2">
                    <p className="text-sm text-muted-foreground">
                      {entity.column_count} columns
                      {s?.table_kind && ` · ${s.table_kind}`}
                    </p>
                    {s && (
                      <div className="flex flex-col gap-1">
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${pct === 100 ? "bg-emerald-600" : "bg-primary"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          Required {s.required_done}/{s.required_total} · recommended{" "}
                          {s.recommended_done}/{s.recommended_total}
                        </p>
                      </div>
                    )}
                    <div>
                      {status === "needs_review" && <Badge variant="destructive">Changed in Dremio</Badge>}
                      {status === "reviewed" && s?.review.reviewed_at && (
                        <Badge variant="secondary">
                          Reviewed by {s.review.reviewed_by} ·{" "}
                          {new Date(s.review.reviewed_at).toLocaleDateString()}
                        </Badge>
                      )}
                      {status === "todo" && <Badge variant="outline">Not reviewed</Badge>}
                      {s && s.search_index.status !== "ok" && (
                        <Badge variant="outline" className="ml-1 border-amber-500 text-amber-700 dark:text-amber-400">
                          {s.search_index.status === "never" ? "Not indexed" : "Index out of date"}
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                </Link>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
