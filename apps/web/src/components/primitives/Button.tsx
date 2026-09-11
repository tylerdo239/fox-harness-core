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
import type { ComponentPropsWithoutRef } from 'react'

export function Button({
  variant,
  className,
  type = 'button',
  ...rest
}: ComponentPropsWithoutRef<'button'> & {
  variant: 'primary' | 'raised' | 'outline' | 'link'
}) {
  return (
    <button {...rest} type={type} className={`fh-btn fh-btn-${variant}${className ? ` ${className}` : ''}`} />
  )
}
