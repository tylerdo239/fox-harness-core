// Deliberately NOT `useTheme.ts`'s pattern (every consumer calls the hook
// independently, each with its own `useState` reading the same
// `localStorage` key). That pattern is correct for theme because its only
// visible effect is one global DOM attribute (`data-theme` on `<html>`)
// mutated by whichever instance's `toggle()` fires — there's never more
// than one `ThemeToggle` mounted at a time needing to reflect a change
// live. Locale text has to update in MANY components mounted
// simultaneously (Sidebar, HistoryChat, Conversation, SettingsDialog,
// AccountMenu, ...) — independent hook instances would mean choosing a
// language in `LanguageSelect.tsx` silently does nothing to everything
// else already on screen. This needs one shared source of truth, same
// reason `runtime.ts`'s `RuntimeContext`/`useRuntime()` (in this same
// directory's parent) is a Context and not a per-component hook.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

import { en, vi, type Locale, type TranslationKey } from './translations.ts'

const STORAGE_LOCALE = 'fox-harness/locale'
const DICTS: Record<Locale, Record<TranslationKey, string>> = { vi, en }

// Always defaults to 'vi' regardless of the browser's own language — an
// explicit product decision (unlike `useTheme.ts`'s OS-follow default),
// not an oversight.
function storedLocale(): Locale {
  return localStorage.getItem(STORAGE_LOCALE) === 'en' ? 'en' : 'vi'
}

interface LocaleContextValue {
  locale: Locale
  t: (key: TranslationKey, params?: Record<string, string>) => string
  toggle: () => void
  setLocale: (next: Locale) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(storedLocale)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // Real gap fixed 2026-09-10: Settings > General's language picker
  // (`features/settings/LanguageSelect.tsx` — a real dropdown with both options
  // visible, not just a toggle button) needs to set an EXPLICIT target —
  // choosing "English" while already on English is a no-op click, not a
  // flip, which `toggle()` alone can't express. `toggle()` now just calls
  // this with the flipped value.
  function setLocale(next: Locale): void {
    localStorage.setItem(STORAGE_LOCALE, next)
    setLocaleState(next)
  }

  function toggle(): void {
    setLocale(locale === 'vi' ? 'en' : 'vi')
  }

  function t(key: TranslationKey, params?: Record<string, string>): string {
    let text = DICTS[locale][key]
    if (params) {
      for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value)
    }
    return text
  }

  return <LocaleContext.Provider value={{ locale, t, toggle, setLocale }}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('fox-harness-web: useLocale() called outside <LocaleProvider>')
  return ctx
}

// services/gateway sends `code` as a plain runtime string (not something
// TypeScript can check against `TranslationKey` at compile time) — only
// 2 routes (`/auth/register`, `/auth/login`) send one today, and only for
// the finite `error.*` codes translations.ts actually has an entry for.
// Falls back to whatever raw message the gateway sent (App.tsx's `login`/
// `register` already keep that as `AuthError.message`) for anything
// missing/unrecognized — never blank, never a raw translation key leaking
// into the UI.
export function translateErrorCode(t: LocaleContextValue['t'], code: string | undefined, fallback: string): string {
  const key = `error.${code}`
  return code && key in vi ? t(key as TranslationKey) : fallback
}
