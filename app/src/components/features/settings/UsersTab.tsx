// Settings > Users (admin only — SettingsDialog.tsx only mounts this for `runtime.userRole === 'admin'`, and
// services/gateway 403s every route here for anyone else). Accounts are admin-created now (self-registration
// is gone): list them (GET /users), create one (POST /users), change a role or reset a password
// (PATCH /users/:id). The gateway revokes a user's logins when either changes — for the admin's OWN password
// that means this tab's token is dead too, so the follow-up reload 401s and `runtime.authedFetch` takes the
// normal "session expired, log in again" path.
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { translateErrorCode, useLocale } from '../../../i18n/locale.tsx'
import { useRuntime, type UserRole } from '../../../runtime.ts'
import { Button } from '../../primitives/Button.tsx'
import { Input } from '../../primitives/Input.tsx'

interface UserRow {
  id: number
  email: string
  role: UserRole
  createdAt: string
}

export function UsersTab({ onClose }: { onClose: () => void }) {
  const runtime = useRuntime()
  const { t, locale } = useLocale()
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<UserRole>('user')
  const [creating, setCreating] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  // The row whose "reset password" input is open, and what's typed in it.
  const [resetId, setResetId] = useState<number | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    const res = await runtime.authedFetch('/users')
    if (res.ok) setUsers((await res.json()) as UserRow[])
    else if (res.status !== 401) toast.error(t('users.loadFailed'))
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime])

  useEffect(() => {
    void load()
  }, [load])

  // The gateway's `{error, code}` -> a translated toast (email_taken, self_demote, invalid_password, ...).
  async function showError(res: Response): Promise<void> {
    if (res.status === 401) return // authedFetch already sent the user back to login
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
    toast.error(translateErrorCode(t, body.code, body.error ?? t('users.actionFailed')))
  }

  async function createUser(): Promise<void> {
    setValidationError(null)
    if (!email.trim()) return setValidationError(t('auth.emailRequired'))
    if (password.length < 8) return setValidationError(t('auth.passwordTooShort'))
    setCreating(true)
    try {
      const res = await runtime.authedFetch('/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, role }),
      })
      if (!res.ok) return await showError(res)
      toast.success(t('users.created', { email: email.trim() }))
      setEmail('')
      setPassword('')
      setRole('user')
      await load()
    } finally {
      setCreating(false)
    }
  }

  async function patchUser(user: UserRow, patch: { role?: UserRole; password?: string }): Promise<boolean> {
    setBusyId(user.id)
    try {
      const res = await runtime.authedFetch(`/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        await showError(res)
        return false
      }
      return true
    } finally {
      setBusyId(null)
    }
  }

  async function changeRole(user: UserRow, next: UserRole): Promise<void> {
    if (await patchUser(user, { role: next })) toast.success(t('users.roleChanged', { email: user.email }))
    await load() // also puts the select back on the real role after a refused change (self_demote)
  }

  async function resetPassword(user: UserRow): Promise<void> {
    if (newPassword.length < 8) {
      toast.error(t('auth.passwordTooShort'))
      return
    }
    if (!(await patchUser(user, { password: newPassword }))) return
    toast.success(t('users.passwordReset', { email: user.email }))
    setResetId(null)
    setNewPassword('')
    // Own password: the gateway just revoked this token — the reload 401s into the normal logout path.
    if (user.email === runtime.userEmail) onClose()
    await load()
  }

  const dateLocale = locale === 'vi' ? 'vi-VN' : 'en-US'

  return (
    <>
      <div className="fh-settings-field-group [margin-bottom:1.5em]">
        <div className="fh-settings-section-title [font:var(--fh-text-s-strong,600_1em/1.4_inherit)] [margin-bottom:0.6em] [color:var(--fg)]">{t('users.createTitle')}</div>
        <form
          className="ds-form flex flex-col [gap:14px]"
          onSubmit={(event) => {
            event.preventDefault()
            void createUser()
          }}
        >
          <Input
            label={t('auth.email')}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            label={t('auth.password')}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <label className="ds-field flex flex-col [gap:6px] [&>span:first-child]:[font-size:0.85em] [&>span:first-child]:font-semibold [&_select]:[height:34px] [&_select]:[padding:0_10px] [&_select]:[border:1px_solid_var(--border)] [&_select]:[border-radius:var(--radius-md)] [&_select]:[background:transparent] [&_select]:[color:var(--fg)] [&_select]:[font:inherit]">
            <span>{t('users.role')}</span>
            <select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
              <option value="user">{t('users.roleUser')}</option>
              <option value="admin">{t('users.roleAdmin')}</option>
            </select>
          </label>
          {validationError && <span className="error [color:var(--error)] [font-size:0.85em]">{validationError}</span>}
          <div className="fh-settings-profile-actions flex justify-end [margin-top:1em]">
            <Button variant="primary" type="submit" disabled={creating}>
              {creating ? t('users.creating') : t('users.create')}
            </Button>
          </div>
        </form>
      </div>

      <div className="fh-settings-field-group [margin-bottom:1.5em]">
        <div className="fh-settings-section-title [font:var(--fh-text-s-strong,600_1em/1.4_inherit)] [margin-bottom:0.6em] [color:var(--fg)]">{t('users.listTitle')}</div>
        {loading ? (
          <div className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t('users.loading')}</div>
        ) : users.length === 0 ? (
          <div className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t('users.empty')}</div>
        ) : (
          <div className="fh-settings-profile-rows">
            {users.map((user) => {
              const isSelf = user.email === runtime.userEmail
              return (
                <div key={user.id} className="ds-form flex flex-col [gap:14px] fh-settings-profile-row items-center justify-between [padding:0.75em_0] [border-bottom:1px_solid_var(--border)] [font-size:0.9em] [&:last-child]:[border-bottom:none]" style={{ alignItems: 'stretch', gap: 8 }}>
                  <div className="ds-field-row flex items-center [gap:8px] [&>*]:[flex:1] [&>*]:min-w-0 [&>button]:flex-none [&_select]:[height:34px] [&_select]:[padding:0_10px] [&_select]:[border:1px_solid_var(--border)] [&_select]:[border-radius:var(--radius-md)] [&_select]:[background:transparent] [&_select]:[color:var(--fg)] [&_select]:[font:inherit]">
                    <span>
                      {user.email}
                      {isSelf && <span className="ds-muted [color:var(--muted)] [font-size:0.85em]"> ({t('users.you')})</span>}
                      <br />
                      <span className="ds-muted [color:var(--muted)] [font-size:0.85em]">
                        {t('users.createdAt', { date: new Date(user.createdAt).toLocaleDateString(dateLocale) })}
                      </span>
                    </span>
                    <select
                      aria-label={t('users.role')}
                      value={user.role}
                      disabled={busyId === user.id}
                      onChange={(event) => void changeRole(user, event.target.value as UserRole)}
                      style={{ flex: 'none' }}
                    >
                      <option value="user">{t('users.roleUser')}</option>
                      <option value="admin">{t('users.roleAdmin')}</option>
                    </select>
                    {resetId !== user.id && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setResetId(user.id)
                          setNewPassword('')
                        }}
                      >
                        {t('users.resetPassword')}
                      </Button>
                    )}
                  </div>
                  {resetId === user.id && (
                    <form
                      className="ds-field-row flex items-center [gap:8px] [&>*]:[flex:1] [&>*]:min-w-0 [&>button]:flex-none [&_select]:[height:34px] [&_select]:[padding:0_10px] [&_select]:[border:1px_solid_var(--border)] [&_select]:[border-radius:var(--radius-md)] [&_select]:[background:transparent] [&_select]:[color:var(--fg)] [&_select]:[font:inherit]"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void resetPassword(user)
                      }}
                    >
                      <Input
                        type="password"
                        autoComplete="new-password"
                        autoFocus
                        placeholder={t('users.newPassword')}
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                      />
                      <Button variant="primary" type="submit" disabled={busyId === user.id}>
                        {t('users.save')}
                      </Button>
                      <Button variant="outline" onClick={() => setResetId(null)}>
                        {t('users.cancel')}
                      </Button>
                    </form>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
