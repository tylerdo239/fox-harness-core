// Copied from bot-data-studio-web-main/src/app/(app)/data-sources/[id]/entities/[entityId]/page.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, ChevronLeft, Loader2, Pencil, TriangleAlert } from "lucide-react";
import { ColumnsGrid, type OpenColumn } from "@/components/profile/columns-grid";
import { ProfileChecklist } from "@/components/profile/profile-checklist";
import { RelationshipProfileDialog } from "@/components/profile/relationship-profile-dialog";
import { SearchIndexStatus } from "@/components/profile/search-index-status";
import { TableProfileForm } from "@/components/profile/table-profile-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getEntityProfile, markEntityProfileReviewed } from "@/lib/api";
import type { EntityProfileDetail } from "@/lib/types";

export default function EntityProfilePage({
  params,
}: {
  params: { id: string; entityId: string };
}) {
  const { id: dataSourceId, entityId } = params;

  const [detail, setDetail] = useState<EntityProfileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [openColumn, setOpenColumn] = useState<OpenColumn | null>(null);

  const [openRelationshipId, setOpenRelationshipId] = useState<string | null>(null);

  // state is only set in promise callbacks, so this can also run from an effect
  const load = useCallback(
    () =>
      getEntityProfile(entityId)
        .then((d) => {
          setDetail(d);
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Failed to load table"))
        .finally(() => setLoading(false)),
    [entityId],
  );

  useEffect(() => {
    load();
  }, [load]);

  async function handleReview() {
    setReviewing(true);
    setActionError(null);
    try {
      setDetail(await markEntityProfileReviewed(entityId));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not mark as reviewed");
    } finally {
      setReviewing(false);
    }
  }

  if (loading && !detail) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error || !detail) {
    return <p className="p-8 text-sm text-destructive">{error ?? "Table not found"}</p>;
  }

  const { entity, review, checklist, columns, relationships } = detail;
  const requiredComplete = checklist.required_done === checklist.required_total;
  // from the checklist: step through every column that still has something missing
  const columnsWithGaps = [
    ...new Set(checklist.missing.filter((m) => m.scope === "column").map((m) => m.target_id)),
  ];
  const openRelationship = relationships.find((r) => r.id === openRelationshipId);

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href={`/data-sources/${dataSourceId}`}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            Tables
          </Link>
          <h1 className="mt-2 text-2xl font-bold">{entity.display_name}</h1>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {entity.physical_path} · {entity.entity_type} · {columns.length} columns
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleReview}
            disabled={reviewing || !requiredComplete}
            title={requiredComplete ? undefined : "Fill in every required item first"}
          >
            {reviewing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <BadgeCheck className="mr-2 h-4 w-4" />
            )}
            Mark as reviewed
          </Button>
        </div>
      </div>

      {actionError && <p className="whitespace-pre-line text-sm text-destructive">{actionError}</p>}

      {review.needs_review && (
        <div className="flex gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium">The table changed in Dremio since the last review</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {review.needs_review_reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {!review.needs_review && review.reviewed_at && (
        <p className="text-sm text-muted-foreground">
          Reviewed by {review.reviewed_by} on {new Date(review.reviewed_at).toLocaleString()}
        </p>
      )}
      <SearchIndexStatus entityId={entityId} status={detail.search_index} onRebuilt={setDetail} />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <TableProfileForm key={entity.id} detail={detail} onSaved={setDetail} />

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Columns</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">
                Edit the main fields right in the grid, select several rows to set them together, and
                open <span className="font-medium">All fields</span> (the slider icon) for description,
                synonyms, value lists and the rest. Changes in the grid are kept until you press Save.
              </p>
              <ColumnsGrid
                entityId={entityId}
                columns={columns}
                missing={checklist.missing}
                open={openColumn}
                onOpen={setOpenColumn}
                onSaved={setDetail}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Relationships</CardTitle>
            </CardHeader>
            <CardContent>
              {relationships.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No relationships yet. Add them on the{" "}
                  <Link href="/data-sources/relationships" className="text-primary hover:underline">
                    Relationships
                  </Link>{" "}
                  page.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Join</TableHead>
                      <TableHead>Keys</TableHead>
                      <TableHead>Cardinality</TableHead>
                      <TableHead>Match rate</TableHead>
                      <TableHead>Fan-out</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {relationships.map((rel) => (
                      <TableRow
                        key={rel.id}
                        className="cursor-pointer"
                        onClick={() => setOpenRelationshipId(rel.id)}
                      >
                        <TableCell className="text-sm">
                          {rel.from_entity_name} → {rel.to_entity_name}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {rel.pairs.map((p) => `${p.from_column} = ${p.to_column}`).join(", ")}
                        </TableCell>
                        <TableCell className="text-xs">
                          {rel.cardinality} · {rel.join_type_default}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {rel.profile.match_rate === null
                            ? "—"
                            : `${Math.round(rel.profile.match_rate * 1000) / 10}%`}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {rel.profile.fanout_ratio ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" aria-label="Edit relationship">
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:sticky lg:top-4">
          <ProfileChecklist
            checklist={checklist}
            onOpenColumn={(id) => setOpenColumn({ id, order: columnsWithGaps })}
          />
        </div>
      </div>

      {openRelationship && (
        <RelationshipProfileDialog
          entityId={entityId}
          relationship={openRelationship}
          open={!!openRelationship}
          onOpenChange={(o) => !o && setOpenRelationshipId(null)}
          onSaved={setDetail}
        />
      )}
    </div>
  );
}
