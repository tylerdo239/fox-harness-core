// Copied from bot-data-studio-web-main/src/lib/use-unsaved-warning.ts by scripts/sync-ref-profile.mjs — edit there, not here.
import { useEffect } from "react";

/** Asks the browser to confirm leaving the page while there are unsaved edits. */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}
