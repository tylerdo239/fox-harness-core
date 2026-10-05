import { useLocale } from '../../../i18n/locale.tsx'
import { MoonIcon, SunIcon } from '../../../icons.tsx'
import { useTheme } from '../../../useTheme.ts'
import { IconButton } from '../../primitives/IconButton.tsx'

// Rendered on the pre-login auth screen (App.tsx's `.fh-auth-screen-controls`)
// — the only place it's mounted since `#header` was removed 2026-09-10.
// Moved out of `components/primitives/` the same day: it owns a real
// app-specific hook (`useTheme()`), it isn't a generic/stateless primitive
// (docs/code-rules.md §67) — `IconButton` (the actual primitive) is what
// it renders through now.
export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const { t } = useLocale()

  return (
    <IconButton
      id="theme-toggle"
      className="fh-theme-toggle"
      onClick={toggle}
      title={theme === 'light' ? t('theme.switchToDark') : t('theme.switchToLight')}
    >
      {theme === 'light' ? <MoonIcon size={14} /> : <SunIcon size={14} />}
    </IconButton>
  )
}
