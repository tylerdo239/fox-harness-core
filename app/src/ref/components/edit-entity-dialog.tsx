// Copied from bot-data-studio-web-main/src/components/edit-entity-dialog.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { updateEntity } from "@/lib/api";
import type { Entity } from "@/lib/types";

export function EditEntityDialog({
  entity,
  onUpdated,
}: {
  entity: Entity;
  onUpdated: (entity: Entity) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState(entity.display_name);
  const [description, setDescription] = useState(entity.description ?? "");
  const [synonyms, setSynonyms] = useState(entity.synonyms.join(", "));
  const [grainDescription, setGrainDescription] = useState(entity.grain_description ?? "");
  const [isExposed, setIsExposed] = useState(entity.is_exposed);
  const [isPii, setIsPii] = useState(entity.is_pii);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setDisplayName(entity.display_name);
      setDescription(entity.description ?? "");
      setSynonyms(entity.synonyms.join(", "));
      setGrainDescription(entity.grain_description ?? "");
      setIsExposed(entity.is_exposed);
      setIsPii(entity.is_pii);
      setError(null);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateEntity(entity.id, {
        display_name: displayName,
        description: description || null,
        synonyms: synonyms
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        grain_description: grainDescription || null,
        is_exposed: isExposed,
        is_pii: isPii,
      });
      onUpdated(updated);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update entity");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon">
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {entity.physical_name}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="display_name">Display name</Label>
            <Input id="display_name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this table represent?"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="grain">Grain description</Label>
            <Input
              id="grain"
              value={grainDescription}
              onChange={(e) => setGrainDescription(e.target.value)}
              placeholder="e.g. one row = one workflow"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="synonyms">Synonyms (comma-separated)</Label>
            <Input
              id="synonyms"
              value={synonyms}
              onChange={(e) => setSynonyms(e.target.value)}
              placeholder="flows, processes"
            />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="exposed">Exposed to agent</Label>
            <Switch id="exposed" checked={isExposed} onCheckedChange={setIsExposed} />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="pii">Contains PII</Label>
            <Switch id="pii" checked={isPii} onCheckedChange={setIsPii} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
