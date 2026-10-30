// Settings > Storage (docs/storage-quota-plan.md): what the user's files take against their quota, every file
// (biggest folders first) to delete what is no longer needed — an upload past the quota is refused until then, and
// that refusal opens this tab. Admins also see the bucket, every user's usage, and the cleanup of files unused for
// N days (preview first, then delete).
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useLocale } from '../../../i18n/locale.tsx'
import { ChevronDownIcon, ChevronRightIcon, TrashIcon } from '../../../icons.tsx'
import { useRuntime } from '../../../runtime.ts'
import { Button } from '../../primitives/Button.tsx'
import { confirmDialog } from '../../primitives/ConfirmDialog.tsx'
import { formatSize } from '../conversation/workspaceApi.ts'
import {
  clearCanvasHistory,
  clearStorageDir,
  deleteStorageCanvas,
  deleteStorageFile,
  getAdminStorage,
  getStorage,
  runCleanup,
  type AdminStorage,
  type CleanupResult,
  type StorageCanvas,
  type StorageDir,
  type UserStorage,
} from './storageApi.ts'

function UsageBar({ used, total, warnPercent }: { used: number; total: number; warnPercent: number }) {
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const full = percent >= 100
  const warn = !full && percent >= warnPercent
  return (
    <div className={`fh-storage-bar [height:8px] [border-radius:999px] [background:var(--border-subtle)] overflow-hidden [&>span]:block [&>span]:h-full [&>span]:[background:var(--accent)] [&>span]:[border-radius:inherit]${full ? ' fh-storage-bar-full [&>span]:[background:var(--status-danger)]' : warn ? ' fh-storage-bar-warn [&&>span]:[background:#d98e04]' : ''}`} role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${percent}%` }} />
    </div>
  )
}

export function StorageTab() {
  const runtime = useRuntime()
  const { t, locale } = useLocale()
  const [storage, setStorage] = useState<UserStorage>()
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const isAdmin = runtime.userRole === 'admin'
  const dateLocale = locale === 'vi' ? 'vi-VN' : 'en-US'

  const load = useCallback(async () => {
    try {
      setStorage(await getStorage(runtime))
    } catch {
      toast.error(t('storage.loadFailed'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime])

  useEffect(() => {
    void load()
  }, [load])

  const dirTitle = (dir: StorageDir) =>
    dir.title ?? (dir.kind === 'project' ? t('storage.untitledProject') : t('historyChat.untitled', { id: dir.id.slice(0, 8) }))

  async function removeFile(dir: StorageDir, path: string): Promise<void> {
    const ok = await confirmDialog({
      title: t('storage.deleteFileTitle'),
      message: t('storage.deleteFileConfirm', { name: path }),
      confirmLabel: t('storage.deleteFile'),
      danger: true,
    })
    if (!ok) return
    setBusy(`${dir.id}/${path}`)
    try {
      await deleteStorageFile(runtime, dir, path)
      toast.success(t('storage.deleted', { name: path.split('/').pop() ?? path }))
      await load()
    } catch {
      toast.error(t('storage.deleteFailed'))
    } finally {
      setBusy(null)
    }
  }

  // docs/canvas-storage-plan.md: the assistant's canvas versions, and the panel's own history
  async function freeCanvas(dir: StorageDir, action: { canvas: StorageCanvas; keepLatest: boolean } | 'history'): Promise<void> {
    const name = action === 'history' ? dirTitle(dir) : action.canvas.id
    const ok = await confirmDialog(
      action === 'history'
        ? { title: t('storage.canvasHistoryTitle'), message: t('storage.canvasHistoryConfirm', { name }), confirmLabel: t('storage.canvasHistoryClear'), danger: true }
        : action.keepLatest
          ? {
              title: t('storage.canvasKeepLatestTitle'),
              message: t('storage.canvasKeepLatestConfirm', { name, n: String(action.canvas.versions - 1) }),
              confirmLabel: t('confirm.delete'),
              danger: true,
            }
          : { title: t('storage.canvasDeleteTitle'), message: t('storage.canvasDeleteConfirm', { name }), confirmLabel: t('storage.canvasDeleteAll'), danger: true },
    )
    if (!ok) return
    setBusy(`${dir.id}/canvas`)
    try {
      const freed =
        action === 'history'
          ? await clearCanvasHistory(runtime, dir)
          : await deleteStorageCanvas(runtime, dir, action.canvas.id, action.keepLatest)
      toast.success(t('storage.cleared', { n: String(freed.files), size: formatSize(freed.bytes) }))
      await load()
    } catch {
      toast.error(t('storage.deleteFailed'))
    } finally {
      setBusy(null)
    }
  }

  const fileCount = (dir: StorageDir) =>
    dir.files.length + dir.canvases.reduce((sum, c) => sum + c.versions, 0) + dir.canvasHistory.files

  async function clearDir(dir: StorageDir): Promise<void> {
    const ok = await confirmDialog({
      title: t('storage.clearTitle'),
      message: t('storage.clearConfirm', { name: dirTitle(dir), n: String(fileCount(dir)) }),
      confirmLabel: t('storage.clear'),
      danger: true,
    })
    if (!ok) return
    setBusy(dir.id)
    try {
      const freed = await clearStorageDir(runtime, dir)
      toast.success(t('storage.cleared', { n: String(freed.files), size: formatSize(freed.bytes) }))
      await load()
    } catch {
      toast.error(t('storage.deleteFailed'))
    } finally {
      setBusy(null)
    }
  }

  if (!storage) return <div className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t('users.loading')}</div>

  const { usedBytes, quotaBytes, warnPercent } = storage
  const percent = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0
  const blocked = storage.bucketFull || (quotaBytes > 0 && percent >= 100)

  return (
    <>
      <div className="fh-settings-field-group [margin-bottom:1.5em]">
        <div className="fh-settings-section-title [font:var(--fh-text-s-strong,600_1em/1.4_inherit)] [margin-bottom:0.6em] [color:var(--fg)]">{t('storage.yours')}</div>
        {quotaBytes > 0 ? (
          <>
            <UsageBar used={usedBytes} total={quotaBytes} warnPercent={warnPercent} />
            <div className="fh-storage-numbers [margin-top:0.5em] [font-size:0.9em]">
              {t('storage.usedOf', { used: formatSize(usedBytes), total: formatSize(quotaBytes), percent: String(Math.round(percent)) })}
            </div>
          </>
        ) : (
          <div className="fh-storage-numbers [margin-top:0.5em] [font-size:0.9em]">{t('storage.usedNoLimit', { used: formatSize(usedBytes) })}</div>
        )}
        {blocked ? (
          <div className="fh-storage-alert [margin-top:0.75em] [padding:0.6em_0.8em] [border-radius:var(--radius-md)] [border:1px_solid_#d98e04] [font-size:0.9em] fh-storage-alert-full [&&]:[border-color:var(--status-danger)] [color:var(--status-danger)]">{t(storage.bucketFull ? 'storage.bucketFull' : 'storage.full')}</div>
        ) : (
          quotaBytes > 0 && percent >= warnPercent && <div className="fh-storage-alert [margin-top:0.75em] [padding:0.6em_0.8em] [border-radius:var(--radius-md)] [border:1px_solid_#d98e04] [font-size:0.9em]">{t('storage.almostFull')}</div>
        )}
        <p className="ds-muted [font-size:0.85em] [color:var(--muted)] fh-storage-hint [margin:0.5em_0_0]">{t('storage.hint')}</p>
      </div>

      <div className="fh-settings-field-group [margin-bottom:1.5em]">
        <div className="fh-settings-section-title [font:var(--fh-text-s-strong,600_1em/1.4_inherit)] [margin-bottom:0.6em] [color:var(--fg)]">{t('storage.folders')}</div>
        {storage.dirs.length === 0 ? (
          <div className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t('storage.empty')}</div>
        ) : (
          <ul className="fh-storage-dirs [list-style:none] m-0 p-0">
            {storage.dirs.map((dir) => (
              <li key={dir.id} className="fh-storage-dir [border-bottom:1px_solid_var(--border)]">
                <div className="fh-storage-dir-row flex items-center [gap:0.75em] [padding:0.5em_0]">
                  <button type="button" className="fh-storage-dir-toggle [flex:1] min-w-0 [height:auto] flex items-center [gap:0.5em] p-0 [border:none] [background:none] [color:inherit] text-left cursor-pointer [font-size:0.9em] [&_.ds-muted]:flex-none [&_.ds-muted]:[font-size:0.9em]" onClick={() => setOpen(open === dir.id ? null : dir.id)}>
                    {open === dir.id ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                    <span className="fh-storage-dir-title min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold" title={dirTitle(dir)}>
                      {dirTitle(dir)}
                    </span>
                    <span className="ds-muted [color:var(--muted)] [font-size:0.85em]">
                      {t(dir.kind === 'project' ? 'storage.kindProject' : 'storage.kindChat')} · {t('storage.fileCount', { n: String(fileCount(dir)) })}
                      {dir.modified && ` · ${new Date(dir.modified).toLocaleDateString(dateLocale)}`}
                    </span>
                  </button>
                  <span className="fh-storage-size flex-none [font-variant-numeric:tabular-nums] [font-size:0.9em]">{formatSize(dir.bytes)}</span>
                  <Button variant="outline" disabled={busy === dir.id} onClick={() => void clearDir(dir)}>
                    {t('storage.clear')}
                  </Button>
                </div>
                {open === dir.id && (
                  <ul className="fh-storage-files [list-style:none] m-0 [padding:0_0_0.5em_1.5em]">
                    {dir.files.map((file) => (
                      <li key={file.path} className="fh-storage-file flex items-center [gap:0.75em] [padding:0.3em_0] [font-size:0.85em] [@media(max-width:560px)]:[&:has(.fh-storage-actions)]:flex-wrap">
                        <span className="fh-storage-file-name min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [flex:1]" title={file.path}>
                          {file.path}
                        </span>
                        <span className="ds-muted [color:var(--muted)] [font-size:0.85em]">{new Date(file.modified).toLocaleDateString(dateLocale)}</span>
                        <span className="fh-storage-size flex-none [font-variant-numeric:tabular-nums] [font-size:0.9em]">{formatSize(file.sizeBytes)}</span>
                        <button
                          type="button"
                          className="fh-storage-delete flex-none [width:28px] [height:28px] inline-flex items-center justify-center p-0 [border:none] [border-radius:var(--radius-sm)] [background:none] [color:var(--muted)] cursor-pointer [&:hover]:[background:var(--bg-hover)] [&:hover]:[color:var(--status-danger)]"
                          title={t('storage.deleteFile')}
                          aria-label={t('storage.deleteFile')}
                          disabled={busy === `${dir.id}/${file.path}`}
                          onClick={() => void removeFile(dir, file.path)}
                        >
                          <TrashIcon size={14} />
                        </button>
                      </li>
                    ))}
                    {dir.canvases.map((canvas) => (
                      <li key={`canvas:${canvas.id}`} className="fh-storage-file flex items-center [gap:0.75em] [padding:0.3em_0] [font-size:0.85em] [@media(max-width:560px)]:[&:has(.fh-storage-actions)]:flex-wrap">
                        <span className="fh-storage-file-name min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [flex:1]" title={canvas.latest}>
                          {t('storage.canvasRow', { name: canvas.id, n: String(canvas.versions) })}
                        </span>
                        <span className="fh-storage-size flex-none [font-variant-numeric:tabular-nums] [font-size:0.9em]">{formatSize(canvas.bytes)}</span>
                        <span className="fh-storage-actions flex flex-none [gap:0.4em]">
                          {canvas.versions > 1 && (
                            <Button variant="outline" disabled={busy === `${dir.id}/canvas`} onClick={() => void freeCanvas(dir, { canvas, keepLatest: true })}>
                              {t('storage.canvasKeepLatest')}
                            </Button>
                          )}
                          <Button variant="outline" disabled={busy === `${dir.id}/canvas`} onClick={() => void freeCanvas(dir, { canvas, keepLatest: false })}>
                            {t('storage.canvasDeleteAll')}
                          </Button>
                        </span>
                      </li>
                    ))}
                    {dir.canvasHistory.files > 0 && (
                      <li className="fh-storage-file flex items-center [gap:0.75em] [padding:0.3em_0] [font-size:0.85em] [@media(max-width:560px)]:[&:has(.fh-storage-actions)]:flex-wrap">
                        <span className="fh-storage-file-name min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [flex:1]">{t('storage.canvasHistory', { n: String(dir.canvasHistory.files) })}</span>
                        <span className="fh-storage-size flex-none [font-variant-numeric:tabular-nums] [font-size:0.9em]">{formatSize(dir.canvasHistory.bytes)}</span>
                        <span className="fh-storage-actions flex flex-none [gap:0.4em]">
                          <Button variant="outline" disabled={busy === `${dir.id}/canvas`} onClick={() => void freeCanvas(dir, 'history')}>
                            {t('storage.canvasHistoryClear')}
                          </Button>
                        </span>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {isAdmin && <AdminStorageSection onChanged={load} />}
    </>
  )
}

const DEFAULT_CLEANUP_DAYS = 90

function AdminStorageSection({ onChanged }: { onChanged: () => Promise<void> }) {
  const runtime = useRuntime()
  const { t, locale } = useLocale()
  const [overview, setOverview] = useState<AdminStorage>()
  const [preview, setPreview] = useState<CleanupResult>()
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    try {
      setOverview(await getAdminStorage(runtime))
    } catch {
      toast.error(t('storage.loadFailed'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime])

  useEffect(() => {
    void load()
  }, [load])

  // no days to type in: the gateway's own FILE_RETENTION_DAYS, or 90 when automatic cleanup is off
  const olderThanDays = overview && overview.fileRetentionDays > 0 ? overview.fileRetentionDays : DEFAULT_CLEANUP_DAYS
  const validDays = overview !== undefined

  async function cleanup(dryRun: boolean): Promise<void> {
    if (!validDays) return
    if (
      !dryRun &&
      !(await confirmDialog({
        title: t('storage.cleanupTitle'),
        message: t('storage.cleanupConfirm', { days: String(olderThanDays) }),
        confirmLabel: t('storage.cleanupRun'),
        danger: true,
      }))
    )
      return
    setRunning(true)
    try {
      const result = await runCleanup(runtime, olderThanDays, dryRun)
      if (dryRun) setPreview(result)
      else {
        setPreview(undefined)
        toast.success(t('storage.cleanupDone', { n: String(result.files), size: formatSize(result.bytes), dirs: String(result.dirs) }))
        await Promise.all([load(), onChanged()])
      }
    } catch {
      toast.error(t('storage.cleanupFailed'))
    } finally {
      setRunning(false)
    }
  }

  if (!overview) return null
  const { bucket } = overview

  return (
    <>
      <div className="fh-settings-field-group [margin-bottom:1.5em]">
        <div className="fh-settings-section-title [font:var(--fh-text-s-strong,600_1em/1.4_inherit)] [margin-bottom:0.6em] [color:var(--fg)]">{t('storage.bucket')}</div>
        {bucket.capacityBytes > 0 && bucket.usedBytes !== undefined ? (
          <>
            <UsageBar used={bucket.usedBytes} total={bucket.capacityBytes} warnPercent={bucket.warnPercent} />
            <div className="fh-storage-numbers [margin-top:0.5em] [font-size:0.9em]">
              {t('storage.usedOf', {
                used: formatSize(bucket.usedBytes),
                total: formatSize(bucket.capacityBytes),
                percent: String(Math.round(bucket.percent ?? 0)),
              })}
              {bucket.scannedAt && ` · ${t('storage.scannedAt', { date: new Date(bucket.scannedAt).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US') })}`}
            </div>
            <p className="ds-muted [font-size:0.85em] [color:var(--muted)] fh-storage-hint [margin:0.5em_0_0]">{t('storage.bucketHint', { block: String(bucket.blockPercent) })}</p>
          </>
        ) : (
          <div className="ds-muted [color:var(--muted)] [font-size:0.85em]">{t(bucket.capacityBytes > 0 ? 'storage.bucketUnknown' : 'storage.bucketNotSet')}</div>
        )}
      </div>

      <div className="fh-settings-field-group [margin-bottom:1.5em]">
        <div className="fh-settings-section-title [font:var(--fh-text-s-strong,600_1em/1.4_inherit)] [margin-bottom:0.6em] [color:var(--fg)]">{t('storage.byUser')}</div>
        <ul className="fh-storage-files [list-style:none] m-0 [padding:0_0_0.5em_1.5em]">
          {overview.users
            .filter((user) => user.usedBytes > 0)
            .map((user) => (
              <li key={user.userId} className="fh-storage-file flex items-center [gap:0.75em] [padding:0.3em_0] [font-size:0.85em] [@media(max-width:560px)]:[&:has(.fh-storage-actions)]:flex-wrap">
                <span className="fh-storage-file-name min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [flex:1]">{user.email}</span>
                <span className="fh-storage-size flex-none [font-variant-numeric:tabular-nums] [font-size:0.9em]">
                  {formatSize(user.usedBytes)}
                  {user.quotaBytes > 0 && ` / ${formatSize(user.quotaBytes)}`}
                </span>
              </li>
            ))}
        </ul>
      </div>

      <div className="fh-settings-field-group [margin-bottom:1.5em]">
        <div className="fh-settings-section-title [font:var(--fh-text-s-strong,600_1em/1.4_inherit)] [margin-bottom:0.6em] [color:var(--fg)]">{t('storage.cleanup')}</div>
        <p className="ds-muted [font-size:0.85em] [color:var(--muted)] fh-storage-hint [margin:0.5em_0_0]">
          {t('storage.cleanupHint', { days: String(olderThanDays) })}{' '}
          {overview.fileRetentionDays > 0
            ? t('storage.retentionOn', { days: String(overview.fileRetentionDays) })
            : t('storage.retentionOff')}
        </p>
        <div className="ds-field-row items-center [gap:8px] flex [&>*]:[flex:1] [&>*]:min-w-0 [&>button]:flex-none [&_select]:[height:34px] [&_select]:[padding:0_10px] [&_select]:[border:1px_solid_var(--border)] [&_select]:[border-radius:var(--radius-md)] [&_select]:[background:transparent] [&_select]:[color:var(--fg)] [&_select]:[font:inherit] fh-storage-cleanup [margin-top:0.75em] [&_input]:[width:8em]">
          <Button variant="outline" disabled={!validDays || running} onClick={() => void cleanup(true)}>
            {t('storage.preview')}
          </Button>
          <Button variant="primary" disabled={!validDays || running || !preview || preview.dirs === 0} onClick={() => void cleanup(false)}>
            {t('storage.cleanupRun')}
          </Button>
        </div>
        {preview && (
          <div className="fh-storage-numbers [margin-top:0.5em] [font-size:0.9em]">
            {preview.dirs === 0
              ? t('storage.previewNone', { days: String(preview.olderThanDays) })
              : t('storage.previewResult', { n: String(preview.files), size: formatSize(preview.bytes), dirs: String(preview.dirs) })}
            {preview.skippedLive > 0 && ` ${t('storage.previewLive', { n: String(preview.skippedLive) })}`}
          </div>
        )}
      </div>
    </>
  )
}
