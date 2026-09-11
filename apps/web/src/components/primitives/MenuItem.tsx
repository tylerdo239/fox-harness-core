// Real primitive extracted 2026-09-10 — `AccountMenu`'s popup items
// (`.fh-account-menu-item`) and `SettingsDialog`'s nav-rail items
// (`.fh-settings-nav-item`) are the same real concept (icon + label, full-
// width flat row, hover background) with 2 real, deliberately-kept-as-is
// pixel differences (padding 0.6em vs 0.75em, radius 8px vs 10px, font
// 0.85em vs 0.9em) — `variant` keeps both exact looks instead of forcing
// one to match the other (this refactor is about deduplicating the
// COMPONENT, not redesigning either screen). Only `nav` currently uses
// `active` (a selected-tab state) — harmless if a `popup` item never
// passes it, since no popup item is ever "selected" today.
import type { ComponentPropsWithoutRef } from 'react'

export function MenuItem({
  variant,
  active,
  className,
  ...rest
}: ComponentPropsWithoutRef<'button'> & {
  variant: 'popup' | 'nav'
  active?: boolean
}) {
  return (
    <button
      {...rest}
      type="button"
      className={`fh-menu-item fh-menu-item-${variant}${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
    />
  )
}
