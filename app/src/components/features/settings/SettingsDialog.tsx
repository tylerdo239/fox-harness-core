// Real settings dialog shell — a modal overlay with a left nav rail
// switching between tabs. 2026-09-10 follow-up: user shared 2 real
// screenshots of claude.ai's own Settings modal (General tab: Theme +
// Language; Profile tab: account info + destructive actions) and asked
// for the same 2-tab shape. This REVERSES the previous deliberate choice
// (Phase 12: "not dsh's real nav-rail tab-switching... tabs are extra
// chrome this project doesn't need") — that was true for 1 section, not 2
// genuinely different ones (appearance/locale prefs vs. account info).
//
// Profile tab deliberately does NOT clone the screenshot 1:1 — it showed
// Name, Phone number, "Log out of all devices", and "Delete account".
// This app's `users` table has no name/phone column, no OAuth sign-in, no
// backend capability to revoke every token for a user (only the CURRENT
// one) or to delete an account at all. Adding those as UI with nothing
// real behind them is exactly the kind of fake chrome this project has
// already refused to do once before (Conversation.tsx's own comment on
// NOT cloning chat.deepseek.com's Instant/Expert/Vision mode tabs — same
// reasoning, confirmed with the user rather than guessed). Profile shows
// the real email, plus a real Logout action (reuses App.tsx's own
// `handleLogout`, the exact same one AccountMenu's popup already calls —
// a second real entry point to the same real action, not a duplicate
// fake one). The Role row this tab briefly had stays removed;
// `runtime.userRole` is back (role-based authz: services/gateway enforces
// `admin`/`user`) and gates the third tab, Users (UsersTab.tsx), which
// only admins see.
//
// `PluginInventory` (the live Cordis Loader diagnostic) is REMOVED from
// here the same day it was added — user asked for it gone from Settings
// entirely, not relocated. Nothing else ever mounted it, so the component
// itself is deleted too (docs/code-rules.md §63), not left as dead code.
// `SettingsPlugins` (the per-user/session plugin enable/disable toggle,
// a DIFFERENT thing) was already removed earlier, Phase 16
// (2026-09-08, docs/agent-core-architecture-roadmap.md) — the whole
// plugin catalog it controlled is gone; every user now gets the same
// fixed capability set.

import { useState } from 'react'

import { useLocale } from '../../../i18n/locale.tsx'
import { CloseIcon, GearIcon, LogOutIcon, MoonIcon, ProfileIcon, SunIcon, UsersIcon } from '../../../icons.tsx'
import { useRuntime } from '../../../runtime.ts'
import { useTheme } from '../../../useTheme.ts'
import { Button } from '../../primitives/Button.tsx'
import { IconButton } from '../../primitives/IconButton.tsx'
import { MenuItem } from '../../primitives/MenuItem.tsx'
import { SelectableCard } from '../../primitives/SelectableCard.tsx'
import { LanguageSelect } from '../LanguageSelect.tsx'
import { UsersTab } from './UsersTab.tsx'

type Tab = 'general' | 'profile' | 'users'

export function SettingsDialog({ open, onClose, onLogout }: { open: boolean; onClose: () => void; onLogout: () => void }) {
  const { t } = useLocale()
  const { theme, setTheme } = useTheme()
  const runtime = useRuntime()
  const [tabState, setTabState] = useState<Tab>('general')

  const isAdmin = runtime.userRole === 'admin'
  // 'users' left over from an admin login on this tab falls back to General for a user.
  const tab: Tab = tabState === 'users' && !isAdmin ? 'general' : tabState
  const setTab = setTabState

  if (!open) return null

  return (
    <div id="settings-dialog" className="fh-settings-dialog">
      <div className="fh-settings-mask" onClick={onClose} />
      <div className="fh-settings-panel" role="dialog" aria-label={t('settings.title')}>
        <div className="fh-settings-panel-header">
          <h2>{t('settings.title')}</h2>
          <IconButton id="settings-close" variant="plain" className="fh-settings-close" onClick={onClose}>
            <CloseIcon size={14} />
          </IconButton>
        </div>
        <div className="fh-settings-body">
          <div className="fh-settings-nav">
            <MenuItem variant="nav" active={tab === 'general'} onClick={() => setTab('general')}>
              <GearIcon size={16} />
              {t('settings.generalTab')}
            </MenuItem>
            <MenuItem variant="nav" active={tab === 'profile'} onClick={() => setTab('profile')}>
              <ProfileIcon size={16} />
              {t('settings.profileTab')}
            </MenuItem>
            {isAdmin && (
              <MenuItem variant="nav" active={tab === 'users'} onClick={() => setTab('users')}>
                <UsersIcon size={16} />
                {t('settings.usersTab')}
              </MenuItem>
            )}
          </div>

          <div id="settings-content" className="fh-settings-content">
            {tab === 'general' && (
              <>
                <div className="fh-settings-field-group">
                  <div className="fh-settings-section-title">{t('settings.theme')}</div>
                  <div className="fh-settings-theme-options">
                    <SelectableCard active={theme === 'light'} onClick={() => setTheme('light')}>
                      <SunIcon size={18} />
                      {t('settings.themeLight')}
                    </SelectableCard>
                    <SelectableCard active={theme === 'dark'} onClick={() => setTheme('dark')}>
                      <MoonIcon size={18} />
                      {t('settings.themeDark')}
                    </SelectableCard>
                  </div>
                </div>

                <div className="fh-settings-field-group">
                  <div className="fh-settings-section-title">{t('settings.language')}</div>
                  <LanguageSelect />
                </div>
              </>
            )}

            {tab === 'profile' && (
              <>
                <div className="fh-settings-profile-rows">
                  <div className="fh-settings-profile-row">
                    <span>{t('settings.profileEmail')}</span>
                    <span className="fh-settings-profile-value">{runtime.userEmail}</span>
                  </div>
                </div>
                <div className="fh-settings-profile-actions">
                  <Button
                    variant="outline"
                    className="fh-settings-profile-logout"
                    onClick={() => {
                      onClose()
                      onLogout()
                    }}
                  >
                    <LogOutIcon size={15} />
                    {t('app.logout')}
                  </Button>
                </div>
              </>
            )}

            {tab === 'users' && isAdmin && <UsersTab onClose={onClose} />}
          </div>
        </div>
      </div>
    </div>
  )
}
