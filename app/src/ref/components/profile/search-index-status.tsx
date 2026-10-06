// Copied from bot-data-studio-web-main/src/components/profile/search-index-status.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reindexEntityProfile } from "@/lib/api";
import type {
  EntityProfileDetail,
  SearchIndexStatus as Status,
} from "@/lib/types";

/** Whether the agent's search can find this table's latest profile, with a rebuild button. */
export function SearchIndexStatus({
  entityId,
  status,
  onRebuilt,
}: {
  entityId: string;
  status: Status;
  onRebuilt: (detail: EntityProfileDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rebuild() {
    setBusy(true);
    setError(null);
    try {
      onRebuilt(await reindexEntityProfile(entityId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rebuild failed");
    } finally {
      setBusy(false);
    }
  }

  if (status.status === "ok") {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        Search index up to date — saved changes are searchable by the agent
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
      <SearchX className="h-4 w-4 shrink-0 text-amber-600" />
      <span className="min-w-0 flex-1">
        {status.status === "never"
          ? "This table is not in the search index yet, so the agent cannot find it."
          : "The search index is out of date for this table; the agent may find old names or miss values."}
        {status.error && (
          <span className="block text-xs text-muted-foreground">
            {status.error}
          </span>
        )}
        {error && (
          <span className="block text-xs text-destructive">{error}</span>
        )}
      </span>
      <Button size="sm" variant="outline" onClick={rebuild} disabled={busy}>
        {busy ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="mr-2 h-4 w-4" />
        )}
        Rebuild index
      </Button>
    </div>
  );
}
