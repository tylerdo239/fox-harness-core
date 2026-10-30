// Real primitive extracted 2026-09-10 — 5 different files each hand-rolled
// their own "circular icon-only button" CSS class (`.fh-theme-toggle`,
// `.fh-sidebar-collapse-toggle`, `.fh-sidebar-search-toggle`,
// `.fh-settings-close`, `.fh-history-chat-row-menu-trigger` — was
// `.fh-session-row-rename`, component renamed 2026-09-10, then again the
// same day once it grew from a direct Rename action into a 2-item
// Rename/Delete popup trigger), 2 of them (theme-toggle family vs.
// settings-close) pixel-identical to each other in everything but
// border/color, all 5 conceptually the exact same control. `variant`
// captures that real difference (`bordered`: visible border, `--fg` —
// theme/collapse/search; `plain`: no border, `--muted` fading to `--fg` on
// hover — settings-close/history-chat-row-menu-trigger); `size` captures
// the one real size difference (28px circle vs.
// history-chat-row-menu-trigger's smaller 16px/4px rounded square).
// `className` still passes through — some call sites (rail-mode
// hide/collapse, hover-reveal inside a history-chat row) need their OWN
// extra selector on top of this shared base; see style.css's own comments
// at each of those rules for why.
import type { ComponentPropsWithoutRef } from 'react'

// One literal per variant (not `fh-...-${variant}`), so each class is a literal the Tailwind move can find
// (docs/ui-performance-plan.md §8).
const SIZE_CLASS = { md: 'fh-icon-btn-md [width:28px] [height:28px]', sm: 'fh-icon-btn-sm [width:16px] [height:16px] [&&]:[border-radius:4px]' } as const
const VARIANT_CLASS = { bordered: 'fh-icon-btn-bordered [border:1px_solid_var(--border)] [color:var(--fg)]', plain: 'fh-icon-btn-plain [border:none] [color:var(--muted)] [&:hover]:[color:var(--fg)]' } as const

export function IconButton({
  size = 'md',
  variant = 'bordered',
  className,
  ...rest
}: ComponentPropsWithoutRef<'button'> & {
  size?: 'md' | 'sm'
  variant?: 'bordered' | 'plain'
}) {
  return (
    <button
      {...rest}
      type="button"
      className={`fh-icon-btn inline-flex items-center justify-center p-0 [background:transparent] [border-radius:999px] [transition:background_var(--duration-fast)_var(--ease),color_var(--duration-fast)_var(--ease)] [&:hover]:[background:var(--bg-hover)] ${SIZE_CLASS[size]} ${VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`}
    />
  )
}
