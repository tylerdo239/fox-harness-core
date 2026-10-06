// Copied from bot-data-studio-web-main/src/app/(app)/data-sources/relationships/page.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  RelationshipEditor,
  SourceBadge,
} from "@/components/profile/relationship-editor";
import { Badge } from "@/components/ui/badge";
import { ProfileTransfer } from "@/components/profile-transfer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { deleteRelationshipItem, getRelationshipItems } from "@/lib/api";
import type { Cardinality, RelationshipItem } from "@/lib/types";

const ALL = "__all__";
const PAGE_SIZE = 10;
type View = "all" | "cross" | "warnings";

const CARDINALITY_LABEL: Record<Cardinality, string> = {
  "1:N": "1 → many",
  "1:1": "1 → 1",
  "N:N": "many → many",
};

export default function RelationshipsPage() {
  const [items, setItems] = useState<RelationshipItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState(ALL);
  const [view, setView] = useState<View>("all");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    getRelationshipItems()
      .then(setItems)
      .catch((err) =>
        setError(
          err instanceof Error ? err.message : "Failed to load relationships",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  const sources = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) {
      m.set(i.from_table.data_source_id, i.from_table.data_source_name);
      m.set(i.to_table.data_source_id, i.to_table.data_source_name);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);

  function handleSaved(saved: RelationshipItem) {
    // an edit keeps its place; a new relationship goes to the top (the list is newest first)
    setItems((prev) =>
      prev.some((r) => r.id === saved.id)
        ? prev.map((r) => (r.id === saved.id ? saved : r))
        : [saved, ...prev],
    );
    if (!items.some((r) => r.id === saved.id)) setPage(1);
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteRelationshipItem(id);
      setItems((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete relationship",
      );
    } finally {
      setConfirmingId(null);
    }
  }

  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => {
    if (
      source !== ALL &&
      i.from_table.data_source_id !== source &&
      i.to_table.data_source_id !== source
    ) {
      return false;
    }
    if (view === "cross" && !i.cross_source) return false;
    if (view === "warnings" && i.warnings.length === 0) return false;
    if (!q) return true;
    const text = [
      i.from_table.display_name,
      i.from_table.physical_path,
      i.to_table.display_name,
      i.to_table.physical_path,
      ...i.pairs.flatMap((p) => [p.from_column, p.to_column]),
    ]
      .join(" ")
      .toLowerCase();
    return text.includes(q);
  });

  // keep the page in range when the list shrinks (filters, deletes)
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = shown.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const counts = {
    all: items.length,
    cross: items.filter((i) => i.cross_source).length,
    warnings: items.filter((i) => i.warnings.length > 0).length,
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/data-sources"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            Data Sources
          </Link>
          <h1 className="mt-2 text-2xl font-bold">Relationships</h1>
          <p className="text-sm text-muted-foreground">
            How tables join, so answers can combine them. Tables can be in
            different data sources.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProfileTransfer
            what="relationships"
            exportPath="/data-profile/relationships/export.json"
            importPath="/data-profile/relationships/import"
            fileName="relationships.json"
            onImported={() => void getRelationshipItems().then(setItems).catch(() => {})}
          />
          <RelationshipEditor
            onSaved={handleSaved}
            trigger={
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New relationship
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
            placeholder="Search tables or columns"
            className="h-8 max-w-xs text-sm"
          />
          <Select
            value={source}
            onValueChange={(v) => {
              setSource(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              {sources.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(
            [
              ["all", `All (${counts.all})`],
              ["cross", `Across sources (${counts.cross})`],
              ["warnings", `With warnings (${counts.warnings})`],
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
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <p className="text-muted-foreground">
          No relationships yet. Add one to tell the agent how two tables join.
        </p>
      )}
      {!loading && items.length > 0 && shown.length === 0 && (
        <p className="text-sm text-muted-foreground">No relationships match.</p>
      )}

      {shown.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">From</th>
                <th className="px-3 py-2" />
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2">Keys</th>
                <th className="px-3 py-2">Rows</th>
                <th className="px-3 py-2">Join</th>
                <th className="px-3 py-2">Match · fan-out</th>
                <th className="w-28 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {pageItems.map((rel) => (
                <tr key={rel.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <SourceBadge name={rel.from_table.data_source_name} />
                    <div className="mt-1 break-all font-mono text-sm font-semibold text-primary">
                      {rel.from_table.physical_path}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {rel.from_table.display_name}
                    </div>
                  </td>
                  <td className="px-1 py-2 pt-7">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </td>
                  <td className="px-3 py-2">
                    <SourceBadge name={rel.to_table.data_source_name} />
                    <div className="mt-1 break-all font-mono text-sm font-semibold text-primary">
                      {rel.to_table.physical_path}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {rel.to_table.display_name}
                    </div>
                    {rel.cross_source && (
                      <Badge variant="secondary" className="mt-1">
                        across sources
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {rel.pairs.map((p) => (
                      <div
                        key={`${p.from_column_id}-${p.to_column_id}`}
                        className="font-mono text-xs"
                      >
                        {p.from_column} = {p.to_column}
                      </div>
                    ))}
                    {rel.warnings.map((w) => (
                      <p
                        key={w}
                        className="mt-1 flex max-w-xs gap-1 text-xs text-amber-700 dark:text-amber-400"
                      >
                        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{" "}
                        {w}
                      </p>
                    ))}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    {CARDINALITY_LABEL[rel.cardinality]}
                  </td>
                  <td className="px-3 py-2 text-xs">{rel.join_type_default}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
                    {rel.profile.match_rate == null
                      ? "—"
                      : `${Math.round(rel.profile.match_rate * 1000) / 10}%`}
                    {" · "}
                    {rel.profile.fanout_ratio ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {confirmingId === rel.id ? (
                      <div className="flex items-center gap-1 text-xs">
                        Delete?
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 px-2"
                          onClick={() => handleDelete(rel.id)}
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
                        <RelationshipEditor
                          relationship={rel}
                          onSaved={handleSaved}
                          trigger={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Edit relationship"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setConfirmingId(rel.id)}
                          aria-label="Delete relationship"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shown.length > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground tabular-nums">
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
            {pageNumbers(currentPage, pageCount).map((n, i) =>
              n === null ? (
                <span key={`gap-${i}`} className="px-1 text-muted-foreground">
                  …
                </span>
              ) : (
                <Button
                  key={n}
                  variant={n === currentPage ? "default" : "ghost"}
                  size="sm"
                  className="min-w-8 tabular-nums"
                  onClick={() => setPage(n)}
                  aria-current={n === currentPage ? "page" : undefined}
                >
                  {n}
                </Button>
              ),
            )}
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

/** Page numbers to show: first, last, and two around the current one; null = gap. */
function pageNumbers(current: number, count: number): (number | null)[] {
  const wanted = new Set(
    [1, count, current - 1, current, current + 1].filter(
      (n) => n >= 1 && n <= count,
    ),
  );
  const sorted = [...wanted].sort((a, b) => a - b);
  const result: (number | null)[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) result.push(null);
    result.push(n);
  });
  return result;
}
