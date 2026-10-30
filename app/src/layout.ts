// The app frame's column widths (split out of App.tsx, docs/ui-performance-plan.md §5).


// Real 2-column frame (sidebar | center), reimplementing dsh's real
// `dsh-client-ui-layout`'s AppFrame algorithm — read directly from its
// actual installed (unminified) compiled output, not guessed
// (docs/code-rules.md's Phase 10 entry has the real research). Same
// breakpoint (1024px) and rail width (56px) as the real one; deliberately
// smaller — no drag-to-resize.
export const SIDEBAR_AUTO_COLLAPSE = 1024;
export const SIDEBAR_RAIL_WIDTH = 56;
export const SIDEBAR_EXPANDED_WIDTH = 280;

export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)));
}

// Same 3-way concession algorithm as dsh's real `computeColumns` — sidebar
// first, then let center shrink, then (if still too tight) close details
// entirely. `details` is always 0 here (nothing occupies it), so this
// project only ever exercises the first two branches in practice.
export function computeColumns(
  viewport: number,
  sidebar: number,
  details: number,
): { sidebar: number; center: number; details: number } {
  const s = sidebar === 0 ? SIDEBAR_RAIL_WIDTH : clampWidth(sidebar, 264, 420);
  const d0 = details === 0 ? 0 : clampWidth(details, 300, 520);
  if (s + d0 + 640 <= viewport)
    return { sidebar: s, center: viewport - s - d0, details: d0 };
  const d1 = d0 === 0 ? 0 : Math.max(300, viewport - s - 640);
  if (s + d1 + 640 <= viewport) return { sidebar: s, center: 640, details: d1 };
  return { sidebar: s, center: Math.max(0, viewport - s), details: 0 };
}
