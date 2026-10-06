// Copied from bot-data-studio-web-main/src/components/profile/profile-checklist.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useState } from "react";
import { CheckCircle2, CircleAlert, CircleDashed } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Checklist, ChecklistItem } from "@/lib/types";

function Progress({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${pct === 100 ? "bg-emerald-600" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

const SHOW = 12;

export function ProfileChecklist({
  checklist,
  onOpenColumn,
}: {
  checklist: Checklist;
  onOpenColumn: (columnId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const required = checklist.missing.filter((m) => m.level === "required");
  const recommended = checklist.missing.filter(
    (m) => m.level === "recommended",
  );
  const ordered = [...required, ...recommended];
  const visible = showAll ? ordered : ordered.slice(0, SHOW);

  function Item({ item }: { item: ChecklistItem }) {
    const Icon = item.level === "required" ? CircleAlert : CircleDashed;
    const body = (
      <>
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${item.level === "required" ? "text-destructive" : "text-muted-foreground"}`}
        />
        <span className="min-w-0">
          <span className="font-mono text-xs">{item.target_name}</span>
          <span className="block text-xs text-muted-foreground">
            {item.message}
          </span>
        </span>
      </>
    );
    return item.scope === "column" ? (
      <button
        type="button"
        onClick={() => onOpenColumn(item.target_id)}
        className="flex w-full items-start gap-2 rounded px-1 py-1 text-left hover:bg-accent"
      >
        {body}
      </button>
    ) : (
      <div className="flex items-start gap-2 px-1 py-1">{body}</div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">What is missing</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Progress
          done={checklist.required_done}
          total={checklist.required_total}
          label="Required"
        />
        <Progress
          done={checklist.recommended_done}
          total={checklist.recommended_total}
          label="Recommended"
        />
        {ordered.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" /> Everything is filled in.
          </p>
        ) : (
          <div className="flex flex-col">
            {visible.map((item, i) => (
              <Item key={`${item.target_id}-${item.field}-${i}`} item={item} />
            ))}
            {ordered.length > SHOW && (
              <button
                type="button"
                onClick={() => setShowAll(!showAll)}
                className="mt-1 text-left text-xs text-primary hover:underline"
              >
                {showAll ? "Show less" : `Show all ${ordered.length}`}
              </button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
