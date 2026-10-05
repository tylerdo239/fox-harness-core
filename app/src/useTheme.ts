// theme.css's tokens already had full light + dark values (Phase 14), but
// nothing ever let the user CHOOSE — dark only ever applied automatically
// via `prefers-color-scheme`, invisible/uncontrollable from inside the app.
// This hook adds the explicit override: `[data-theme="light"|"dark"]` on
// <html>, which theme.css already reads (its dark block is scoped
// `:root:not([data-theme="light"])`, and there's a separate
// `:root[data-theme="dark"]` block) — so setting the attribute is the whole
// mechanism, no new CSS needed.
//
// Deliberately does NOT persist anything until the user actually clicks the
// toggle: until then this follows the OS `prefers-color-scheme` live (via
// the `change` listener below) with no `data-theme` attribute set at all —
// the same "no stored value -> let the media query decide" rule
// `index.html`'s anti-FOUC inline script already uses. Writing a derived
// default to storage on mount would have silently locked every first-time
// visitor into whatever their OS happened to be set to, with no way back to
// "just follow the system" short of clearing site data.
import { useEffect, useState } from 'react'

const STORAGE_THEME = 'fox-harness/theme'

export type Theme = 'light' | 'dark'

function storedOverride(): Theme | null {
  const stored = localStorage.getItem(STORAGE_THEME)
  return stored === 'light' || stored === 'dark' ? stored : null
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (next: Theme) => void } {
  const [override, setOverride] = useState<Theme | null>(storedOverride)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const theme: Theme = override ?? (systemDark ? 'dark' : 'light')

  useEffect(() => {
    if (override) document.documentElement.dataset.theme = override
    else delete document.documentElement.dataset.theme
  }, [override])

  // Real gap fixed 2026-09-10: Settings > General's theme picker (2 real
  // cards, Light/Dark) needs to set an EXPLICIT target, not flip whatever
  // the current one is — `toggle()` alone can't express "set to light" when
  // already light. `toggle()` now just calls this with the flipped value,
  // so both stay in sync instead of duplicating the storage-write logic.
  function setTheme(next: Theme): void {
    localStorage.setItem(STORAGE_THEME, next)
    setOverride(next)
  }

  function toggle(): void {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }

  return { theme, toggle, setTheme }
}
