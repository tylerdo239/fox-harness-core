// Real chat.deepseek.com/claude.ai pattern (2026-09-10 follow-up): the
// sidebar footer's account row used to open the Settings dialog directly
// (Sidebar.tsx's Phase 15) — now it opens a small popup ABOVE itself
// instead (the row sits at the very bottom of the sidebar, no room to
// open downward), with Settings/Logout as separate items. The row itself
// grows a trailing "..." (`MoreIcon`) affordance hinting it opens a menu
// now, not a direct action.
//
// Portaled to `document.body`, not rendered inline next to the trigger —
// `#sidebar-col` has a real, load-bearing `overflow: hidden` (Phase 15,
// needed for the collapse-to-rail width transition) that would otherwise
// clip the popup, especially in rail mode where the sidebar itself is only
// 56px wide. Position is computed from the trigger's own
// `getBoundingClientRect()` at open time — this app has no portal/popover
// anywhere else yet, but it's the standard, correct fix for exactly this
// "popup needs to escape an overflow:hidden ancestor" problem, not
// over-engineering for its own sake.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useLocale } from '../../../i18n/locale.tsx'
import { GearIcon, LogOutIcon, MoreIcon } from '../../../icons.tsx'
import { useRuntime } from '../../../runtime.ts'
import { MenuItem } from '../../primitives/MenuItem.tsx'

export function AccountMenu({ onOpenSettings, onLogout }: { onOpenSettings: () => void; onLogout: () => void }) {
  const runtime = useRuntime()
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  function openMenu(): void {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    // Anchored above the trigger (`bottom`, not `top`) — same reasoning
    // Conversation.tsx's own `/`-command dropdown already uses for the
    // exact same "trigger sits near the bottom of its container" problem.
    setPosition({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
    setOpen(true)
  }

  // Dismiss on an outside click or Escape — this app's first popup that
  // needs to be dismissable this way (the existing command dropdown closes
  // via its own text-input state instead, not a click-outside listener).
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

  const initial = (runtime.userEmail || '?').charAt(0).toUpperCase()

  return (
    <>
      <button
        id="account-menu-trigger"
        ref={triggerRef}
        className="fh-sidebar-account"
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        title={t('sidebar.accountMenu')}
      >
        <span className="fh-sidebar-account-avatar">{initial}</span>
        <span className="fh-sidebar-account-email">{runtime.userEmail || t('sidebar.account')}</span>
        <MoreIcon size={16} className="fh-sidebar-account-more" />
      </button>
      {open &&
        position &&
        createPortal(
          <div ref={popupRef} className="fh-account-menu-popup" style={{ left: position.left, bottom: position.bottom }}>
            <MenuItem
              variant="popup"
              onClick={() => {
                setOpen(false)
                onOpenSettings()
              }}
            >
              <GearIcon size={15} />
              {t('sidebar.settings')}
            </MenuItem>
            <MenuItem
              variant="popup"
              onClick={() => {
                setOpen(false)
                onLogout()
              }}
            >
              <LogOutIcon size={15} />
              {t('app.logout')}
            </MenuItem>
          </div>,
          document.body,
        )}
    </>
  )
}
