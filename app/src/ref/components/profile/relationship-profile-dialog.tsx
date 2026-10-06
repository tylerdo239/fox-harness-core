// Copied from bot-data-studio-web-main/src/components/profile/relationship-profile-dialog.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HelpLabel } from "@/components/profile/field-help";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { updateRelationshipProfile } from "@/lib/api";
import type { EntityProfileDetail, ProfileRelationship } from "@/lib/types";

export function RelationshipProfileDialog({
  entityId,
  relationship,
  open,
  onOpenChange,
  onSaved,
}: {
  entityId: string;
  relationship: ProfileRelationship;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (detail: EntityProfileDetail) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && (
          <RelationshipForm
            entityId={entityId}
            relationship={relationship}
            onCancel={() => onOpenChange(false)}
            onSaved={(d) => {
              onSaved(d);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RelationshipForm({
  entityId,
  relationship,
  onCancel,
  onSaved,
}: {
  entityId: string;
  relationship: ProfileRelationship;
  onCancel: () => void;
  onSaved: (detail: EntityProfileDetail) => void;
}) {
  const p = relationship.profile;
  // match rate is typed as a percentage, stored as 0–1
  const [matchRate, setMatchRate] = useState(
    p.match_rate === null ? "" : String(Math.round(p.match_rate * 1000) / 10),
  );
  const [fanout, setFanout] = useState(
    p.fanout_ratio === null ? "" : String(p.fanout_ratio),
  );
  const [notes, setNotes] = useState(p.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function num(text: string): number | null {
    if (!text.trim()) return null;
    const n = Number(text.replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  }

  async function handleSave() {
    const rate = num(matchRate);
    const ratio = num(fanout);
    if (Number.isNaN(rate) || Number.isNaN(ratio)) {
      setError("Match rate and fan-out must be numbers");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await updateRelationshipProfile(entityId, relationship.id, {
          match_rate: rate === null ? null : rate / 100,
          fanout_ratio: ratio,
          notes: notes.trim() || null,
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save relationship",
      );
    } finally {
      setSaving(false);
    }
  }

  const keys = relationship.pairs
    .map((p) => `${p.from_column} = ${p.to_column}`)
    .join(", ");

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {relationship.from_entity_name} → {relationship.to_entity_name}
        </DialogTitle>
        <DialogDescription>
          {keys} · {relationship.cardinality ?? "?"} · default{" "}
          {relationship.join_type_default ?? "?"} join. Both numbers are
          optional; leave them empty if nobody has checked.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 py-2">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="match_rate" htmlFor="rp_match">
              Match rate (%)
            </HelpLabel>
            <Input
              id="rp_match"
              value={matchRate}
              onChange={(e) => setMatchRate(e.target.value)}
              placeholder="97.8"
              inputMode="decimal"
            />
            <span className="text-xs text-muted-foreground">
              Share of {relationship.from_entity_name} rows that find a match
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <HelpLabel help="fanout" htmlFor="rp_fanout">
              Fan-out
            </HelpLabel>
            <Input
              id="rp_fanout"
              value={fanout}
              onChange={(e) => setFanout(e.target.value)}
              placeholder="1.0"
              inputMode="decimal"
            />
            <span className="text-xs text-muted-foreground">
              Rows after the join ÷ rows before (1 = no duplication)
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <HelpLabel help="relationship_notes" htmlFor="rp_notes">
            Notes
          </HelpLabel>
          <Textarea
            id="rp_notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. orders before 03/2024 have no branch"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
