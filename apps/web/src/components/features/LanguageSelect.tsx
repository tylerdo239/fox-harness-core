// Real UI added 2026-09-10 — Settings > General's language control used
// to be a bare native `<select>` (deliberately, per docs/code-rules.md
// §67 — a Select primitive felt like over-engineering for 1 use site with
// already-shared `select {}` CSS). User pointed out it genuinely had no
// real UI of its own, especially sitting right below the Theme picker's
// 2 real styled cards — a native dropdown looked out of place next to
// that. This replaces it with a real trigger + popup, reusing
// `primitives/MenuItem.tsx` (already exactly the right shape: icon-less
// here, but the same "row, hover bg, active state" concept) for the 2
// options — not a new primitive, since this is still genuinely the only
// dropdown-of-this-kind in the app.
//
// Portaled to `document.body`, mirroring `AccountMenu.tsx`'s own
// popup exactly (trigger ref -> `getBoundingClientRect()` -> fixed
// position -> outside-click/Escape dismiss) — `.fh-settings-content`
// (its container when opened from Settings) has `overflow-y: auto`,
// which would risk clipping an inline-positioned popup the same way
// `#sidebar-col`'s `overflow: hidden` would have clipped AccountMenu's;
// reusing the same proven technique instead of risking a new clipping bug.
//
// Same day follow-up: also replaces `LangToggle.tsx` on the pre-login
// auth screen (deleted — this was its only other call site) — same real
// dropdown everywhere instead of a plain toggle button in one place and a
// real dropdown in another. Moved out of `features/settings/` up to
// `features/` itself once it gained a second, unrelated consumer
// (`App.tsx`'s auth screen) — it no longer belongs to just one page
// section, same "group by real usage" rule docs/code-rules.md §71 used to
// organize this folder in the first place.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useLocale } from '../../i18n/locale.tsx'
import { ChevronDownIcon } from '../../icons.tsx'
import { MenuItem } from '../primitives/MenuItem.tsx'

export function LanguageSelect() {
  const { locale, setLocale } = useLocale()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  function openMenu(): void {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({ left: rect.left, top: rect.bottom + 4, width: rect.width })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent): void {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function choose(next: 'vi' | 'en'): void {
    setLocale(next)
    setOpen(false)
  }

  return (
    <>
      <button
        id="language-select"
        ref={triggerRef}
        type="button"
        className="fh-lang-select-trigger"
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span>{locale === 'vi' ? 'Tiếng Việt' : 'English'}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={popupRef}
            className="fh-lang-select-popup"
            style={{ left: position.left, top: position.top, width: position.width }}
          >
            <MenuItem variant="popup" active={locale === 'vi'} onClick={() => choose('vi')}>
              Tiếng Việt
            </MenuItem>
            <MenuItem variant="popup" active={locale === 'en'} onClick={() => choose('en')}>
              English
            </MenuItem>
          </div>,
          document.body,
        )}
    </>
  )
}
