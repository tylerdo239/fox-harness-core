// Real primitive extracted 2026-09-10 — every "real" button shape in this
// app (the accent-filled primary CTA, the neutral raised pill, the
// outline pill, the text-only link) was a separate hand-rolled CSS class
// per call site (`button[type=submit]`, `.fh-sidebar-new-session`,
// `.fh-lang-toggle`/`.fh-settings-profile-logout`, `.fh-auth-switch`) —
// `variant` names each by what it actually IS, not by which file it used
// to live in. `primary` deliberately declares almost nothing of its own:
// the page's base `button {}` reset (style.css) already gives every plain
// `<button>` the accent fill — `.fh-btn-primary` only adds the pill
// shape/padding on top, exactly mirroring what the old `button[type=submit]`
// rule did. `type` defaults to `'button'` (never accidentally submits a
// form by omission) — callers that need a real submit button pass
// `type="submit"` explicitly, same as before.
//
// Used to also take a `size` prop (`outline` had 2 real sizes — `sm` was
// `.fh-lang-toggle`, `md` was the Settings Profile-tab Logout button) —
// dropped 2026-09-10 once `LangToggle.tsx` was deleted (replaced
// everywhere by the real `LanguageSelect.tsx` dropdown) left `outline`
// with only ever 1 real size. No point keeping a dimension nothing
// exercises — add it back for real if a 2nd size is ever actually needed.
import { forwardRef, type ComponentPropsWithoutRef } from 'react'

// `danger` (2026-10-29): red fill for destructive confirms (ConfirmDialog.tsx).
// One literal per variant (not `fh-...-${variant}`), so each class is a literal the Tailwind move can find
// (docs/ui-performance-plan.md §8).
const VARIANT_CLASS = {
  primary: 'fh-btn-primary [border-radius:999px] [padding:0_1.3em]',
  raised: 'fh-btn-raised [height:38px] [padding:8px_16px] [border:1px_solid_var(--border)] [border-radius:999px] [background:var(--bg-raised)] [color:var(--fg)] [font-size:14px] font-medium [transition:background_var(--duration-fast)_var(--ease)] [&:hover]:[background:var(--bg-hover)]',
  outline: 'fh-btn-outline [height:34px] [padding:0_1em] [background:transparent] [color:var(--fg)] [border:1px_solid_var(--border)] [border-radius:999px] [font-size:0.85em] [transition:background_var(--duration-fast)_var(--ease)] [&:hover]:[background:var(--bg-hover)]',
  link: 'fh-btn-link [height:28px] [padding:0_10px] [border-radius:14px] [background:transparent] [border:none] [color:var(--accent-text)] [font:inherit] [&&]:[font-size:0.85em] [&:hover]:[text-decoration:underline] [&:hover]:[background:transparent]',
  danger: 'fh-btn-danger [border-radius:999px] [padding:0_1.3em] [border-color:var(--status-danger)] [background:var(--status-danger)] [color:#fff] [&:hover]:[background:color-mix(in_srgb,var(--status-danger)_85%,#000)]',
} as const

export const Button = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & {
    variant: 'primary' | 'raised' | 'outline' | 'link' | 'danger'
  }
>(function Button({ variant, className, type = 'button', ...rest }, ref) {
  return (
    <button {...rest} ref={ref} type={type} className={`fh-btn inline-flex items-center justify-center [gap:6px] cursor-pointer [&.fh-ds-import]:[height:40px] [&.fh-ds-import]:[padding:0_1.4em] [&.fh-ds-import]:font-semibold [&.fh-ds-import]:[box-shadow:0_2px_10px_color-mix(in_srgb,var(--accent)_35%,transparent)] [&.fh-ds-import:disabled]:[box-shadow:none] ${VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`} />
  )
})
