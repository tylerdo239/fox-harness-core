// Copied from bot-data-studio-web-main/src/components/profile/field-help.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { CircleHelp } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Label } from "@/components/ui/label";
import {
  PROFILE_HELP,
  type FieldHelpText,
  type ProfileHelpKey,
} from "@/lib/profile-help";

const LEVEL_LABEL: Record<NonNullable<FieldHelpText["level"]>, string> = {
  required: "Bắt buộc",
  recommended: "Nên điền",
  optional: "Không bắt buộc",
};

/** A "?" icon that shows how to fill the field on hover or keyboard focus. */
export function FieldHelp({ id }: { id: ProfileHelpKey }) {
  const help: FieldHelpText = PROFILE_HELP[id];
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Cách điền: ${help.title}`}
          onClick={(e) => e.preventDefault()}
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </HoverCardTrigger>
      {/* portal: stays on top of dialogs and isn't clipped by scrolling containers */}
      <HoverCardPrimitive.Portal>
        <HoverCardContent
          side="top"
          align="start"
          className="w-80 text-left text-sm font-normal normal-case"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-semibold">{help.title}</p>
            {help.level && (
              <span
                className={`shrink-0 text-[11px] ${help.level === "required" ? "text-destructive" : "text-muted-foreground"}`}
              >
                {LEVEL_LABEL[help.level]}
              </span>
            )}
          </div>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            {help.body}
          </p>
          {help.example && (
            <p className="mt-2 rounded bg-muted px-2 py-1 text-xs leading-relaxed">
              <span className="font-medium">Ví dụ: </span>
              {help.example}
            </p>
          )}
        </HoverCardContent>
      </HoverCardPrimitive.Portal>
    </HoverCard>
  );
}

/** Red asterisk for a field that must be filled before the table can be marked as reviewed. */
export function RequiredMark() {
  return (
    <>
      <span className="ml-0.5 text-destructive" aria-hidden="true">
        *
      </span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

/** A field label followed by its help icon. */
export function HelpLabel({
  help,
  htmlFor,
  className,
  action,
  required,
  children,
}: {
  help: ProfileHelpKey;
  htmlFor?: string;
  className?: string;
  /** extra control after the help icon, e.g. the AI suggest button */
  action?: React.ReactNode;
  /** show the red * (pass the same condition the checklist uses) */
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={`flex items-center gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor}>
        {children}
        {required && <RequiredMark />}
      </Label>
      <FieldHelp id={help} />
      {action}
    </span>
  );
}
