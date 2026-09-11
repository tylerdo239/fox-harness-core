// Real primitive extracted 2026-09-10 from `.fh-settings-theme-card`
// (Settings > General's Light/Dark picker) — only 1 real call site today
// (2 instances of it), but a genuinely distinct UI concept from
// `MenuItem` (a bordered card, icon stacked ABOVE the label, not a flat
// row) worth naming on its own rather than folding into `MenuItem` with
// extra layout props — extracted per the plan's own "primitives to reuse
// going forward," not because it was already duplicated.
import type { ComponentPropsWithoutRef } from 'react'

export function SelectableCard({
  active,
  className,
  ...rest
}: ComponentPropsWithoutRef<'button'> & { active?: boolean }) {
  return (
    <button
      {...rest}
      type="button"
      className={`fh-selectable-card${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
    />
  )
}
