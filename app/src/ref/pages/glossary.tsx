// Copied from bot-data-studio-web-main/src/app/(app)/glossary/page.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useEffect, useState } from "react";
import { BookText, ChevronLeft, ChevronRight, Filter, Gauge, Loader2, Pencil, Plus, SearchX, Trash2 } from "lucide-react";
import { GlossaryEditor } from "@/components/profile/glossary-editor";
import { Badge } from "@/components/ui/badge";
import { ProfileTransfer } from "@/components/profile-transfer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteGlossaryItem, getGlossaryItems, setGlossaryItemEnabled } from "@/lib/api";
import { AgentToggle } from "@/components/agent-toggle";
import type { GlossaryItem, TermKind } from "@/lib/types";

const PAGE_SIZE = 10;
type View = "all" | TermKind;

const KIND_LABEL: Record<TermKind, string> = {
  segment: "Segment",
  metric: "Metric name",
  definition: "Convention",
};
const KIND_ICON = { segment: Filter, metric: Gauge, definition: BookText } as const;

export default function GlossaryPage() {
  const [items, setItems] = useState<GlossaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");
  const [page, setPage] = useState(1);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    getGlossaryItems()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load the glossary"))
      .finally(() => setLoading(false));
  }, []);

  function handleSaved(saved: GlossaryItem) {
    const isNew = !items.some((t) => t.id === saved.id);
    setItems((prev) => (isNew ? [saved, ...prev] : prev.map((t) => (t.id === saved.id ? saved : t))));
    if (isNew) setPage(1);
  }

  async function handleEnabled(id: string, enabled: boolean) {
    const saved = await setGlossaryItemEnabled(id, enabled);
    setItems((prev) => prev.map((t) => (t.id === id ? saved : t)));
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteGlossaryItem(id);
      setItems((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete the term");
    } finally {
      setConfirmingId(null);
    }
  }

  const q = query.trim().toLowerCase();
  const shown = items.filter((t) => {
    if (view !== "all" && t.kind !== view) return false;
    if (!q) return true;
    return [t.term, ...t.synonyms, t.definition ?? "", t.meaning].join(" ").toLowerCase().includes(q);
  });
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = shown.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const count = (k: View) => (k === "all" ? items.length : items.filter((t) => t.kind === k).length);

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Glossary</h1>
          <p className="text-sm text-muted-foreground">
            Words people use in questions that need one fixed meaning: groups of rows, other names for
            metrics, and conventions the agent must follow.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProfileTransfer
            what="glossary terms"
            exportPath="/data-profile/glossary/export.json"
            importPath="/data-profile/glossary/import"
            fileName="glossary.json"
            onImported={() => void getGlossaryItems().then(setItems).catch(() => {})}
          />
          <GlossaryEditor
            onSaved={handleSaved}
            trigger={
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New term
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
            placeholder="Search terms"
            className="h-8 max-w-xs text-sm"
          />
          {(["all", "segment", "metric", "definition"] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setView(v);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${
                view === v ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent"
              }`}
            >
              {v === "all" ? "All" : KIND_LABEL[v]} ({count(v)})
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && <p className="whitespace-pre-line text-sm text-destructive">{error}</p>}
      {!loading && items.length === 0 && (
        <p className="text-muted-foreground">
          No terms yet. Add the words people use that the data doesn&apos;t name directly, e.g.
          &ldquo;khách VIP&rdquo; or &ldquo;hội thoại đang mở&rdquo;.
        </p>
      )}
      {!loading && items.length > 0 && shown.length === 0 && (
        <p className="text-sm text-muted-foreground">No terms match.</p>
      )}

      {pageItems.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Term</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Means</th>
                <th className="px-3 py-2">Status</th>
                <th className="w-28 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {pageItems.map((t) => {
                const Icon = KIND_ICON[t.kind];
                const missing = t.checklist.required_total - t.checklist.required_done;
                return (
                  <tr key={t.id} className={`border-t align-top ${t.disabled ? "bg-muted/40 [&>td:not(:last-child)]:opacity-60" : ""}`}>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-primary">{t.term}</div>
                      {t.synonyms.length > 0 && (
                        <div className="max-w-xs text-xs text-muted-foreground">{t.synonyms.join(", ")}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" /> {KIND_LABEL[t.kind]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {t.kind === "segment" && t.table && (
                        <div className="break-all font-mono text-xs font-semibold text-primary">
                          {t.table.physical_path}
                        </div>
                      )}
                      {t.kind === "metric" ? (
                        <div className="text-xs">
                          <span className="font-mono font-semibold text-primary">{t.metric_name ?? "?"}</span>
                          {t.metric_display_name && (
                            <span className="text-muted-foreground"> · {t.metric_display_name}</span>
                          )}
                        </div>
                      ) : (
                        <div className="max-w-md break-words font-mono text-xs">
                          {t.kind === "segment" ? t.meaning.replace(/^rows of \S+ where /, "") : ""}
                        </div>
                      )}
                      {t.definition && (
                        <div className="line-clamp-2 max-w-md text-xs text-muted-foreground">{t.definition}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-start gap-1">
                        {t.disabled && <Badge variant="outline">Disabled</Badge>}
                        {missing > 0 ? (
                          <Badge variant="destructive">{missing} missing</Badge>
                        ) : (
                          <Badge variant="secondary">ok</Badge>
                        )}
                        {t.search_index.status && t.search_index.status !== "ok" && (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
                            title={t.search_index.error ?? undefined}
                          >
                            <SearchX className="h-3 w-3" /> not indexed — save again
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {confirmingId === t.id ? (
                        <div className="flex items-center gap-1 text-xs">
                          Delete?
                          <Button size="sm" variant="destructive" className="h-7 px-2" onClick={() => handleDelete(t.id)}>
                            Yes
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setConfirmingId(null)}>
                            No
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <AgentToggle
                            enabled={!t.disabled}
                            onChange={(on) => handleEnabled(t.id, on)}
                            label={`term ${t.term}`}
                            className="mr-1"
                          />
                          <GlossaryEditor
                            item={t}
                            onSaved={handleSaved}
                            trigger={
                              <Button variant="ghost" size="icon" aria-label={`Edit ${t.term}`}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setConfirmingId(t.id)}
                            aria-label={`Delete ${t.term}`}
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
            {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, shown.length)} of {shown.length}
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
