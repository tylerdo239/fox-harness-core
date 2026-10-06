// Copied from bot-data-studio-web-main/src/components/agent-toggle.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** Turns an item (data source, metric, glossary term) on or off for the agents. Off: the item stays in
 *  the profile and can still be edited, but the chat pipeline can't find or use it. */
export function AgentToggle({
  enabled,
  onChange,
  label,
  className,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => Promise<void>;
  label: string; // what is toggled, for screen readers ("metric x")
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
      title={enabled ? "Agents can find and use it. Turn off to hide it from them." : "Hidden from the agents. Turn on to let them use it."}
    >
      <Switch
        checked={enabled}
        disabled={busy}
        onCheckedChange={(v) => void toggle(v)}
        aria-label={`${enabled ? "Disable" : "Enable"} ${label} for the agents`}
        className="h-5 w-9 [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4"
      />
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <span>{enabled ? "On" : "Off"}</span>}
      {error && <span className="text-destructive">{error}</span>}
    </span>
  );
}
