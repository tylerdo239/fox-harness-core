// Settings > Connections (docs/meta-ads-mcp-plan.md): connect the user's own Meta account for the Meta Ads chat.
// The token stays on the server; this tab only shows who is connected, until when, and connects / disconnects.
import { useState } from 'react'
import { toast } from 'sonner'

import { useLocale } from '../../../i18n/locale.tsx'
import { useRuntime } from '../../../runtime.ts'
import { Button } from '../../primitives/Button.tsx'
import { announceMetaConnectionChange, connectMeta, disconnectMeta, useMetaConnection } from '../meta-ads/metaAdsApi.ts'

export function ConnectionsTab() {
  const runtime = useRuntime()
  const { t, locale } = useLocale()
  const { status, reload } = useMetaConnection(runtime)
  const [busy, setBusy] = useState(false)
  const date = (iso: string) => new Date(iso).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US')

  async function onConnect() {
    setBusy(true)
    try {
      const result = await connectMeta(runtime)
      if (result.ok) toast.success(t('connections.connected'))
      else if (result.reason === 'not_configured') toast.error(t('connections.notConfigured'))
      else if (result.reason !== 'closed' && result.reason !== 'redirected') toast.error(t('connections.connectFailed'))
    } finally {
      await reload()
      announceMetaConnectionChange()
      setBusy(false)
    }
  }

  async function onDisconnect() {
    setBusy(true)
    try {
      if (await disconnectMeta(runtime)) toast.success(t('connections.disconnected'))
      else toast.error(t('connections.connectFailed'))
    } finally {
      await reload()
      announceMetaConnectionChange()
      setBusy(false)
    }
  }

  if (!status) return <div className="fh-connections-empty">{t('connections.loading')}</div>
  if (!status.enabled) return <div className="fh-connections-empty">{t('connections.none')}</div>

  return (
    <div className="fh-connections">
      <div className="fh-settings-section-title">{t('connections.title')}</div>
      <div className="fh-connection-card">
        <div className="fh-connection-main">
          <div className="fh-connection-name">Meta (Facebook / Instagram Ads)</div>
          {status.connected ? (
            <div className="fh-connection-detail">
              {status.problem ? (
                <span className="fh-connection-problem">{t('connections.reconnectNeeded')}</span>
              ) : (
                <span className="fh-connection-ok">{t('connections.connectedAs', { name: status.name ?? '—' })}</span>
              )}
              {status.expiresAt && <span>{t('connections.expires', { date: date(status.expiresAt) })}</span>}
            </div>
          ) : (
            <div className="fh-connection-detail">{t('connections.metaHint')}</div>
          )}
        </div>
        <div className="fh-connection-actions">
          {status.connected && (
            <Button variant="outline" disabled={busy} onClick={() => void onDisconnect()}>
              {t('connections.disconnect')}
            </Button>
          )}
          {(!status.connected || status.problem) && (
            <Button variant="raised" disabled={busy} onClick={() => void onConnect()}>
              {status.connected ? t('connections.reconnect') : t('connections.connect')}
            </Button>
          )}
        </div>
      </div>
      <p className="fh-connections-note">{t('connections.privacy')}</p>
    </div>
  )
}
