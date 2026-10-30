// Shared confirm dialog — the in-app replacement for `window.confirm`.
//
// Usage (anywhere, no props/context to thread through):
//   if (!(await confirmDialog({ title, message, confirmLabel, danger: true }))) return
//
// One <ConfirmDialogHost /> is mounted at the app root (App.tsx, next to the
// Toaster); `confirmDialog()` puts a request in a tiny zustand store and
// resolves with true (confirmed) or false (cancel, Escape, mask click).
// A new request while one is open cancels the old one.
import { useEffect, useRef, type ReactNode } from 'react'
import { create } from 'zustand'

import { useLocale } from '../../i18n/locale.tsx'
import { Button } from './Button.tsx'
import { Modal } from './Modal.tsx'

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  // Red confirm button; focus starts on Cancel so a stray Enter doesn't delete.
  danger?: boolean
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

const useConfirmStore = create<{ pending: Pending | null }>(() => ({ pending: null }))

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.getState().pending?.resolve(false)
    useConfirmStore.setState({ pending: { ...options, resolve } })
  })
}

function settle(ok: boolean): void {
  const { pending } = useConfirmStore.getState()
  if (!pending) return
  useConfirmStore.setState({ pending: null })
  pending.resolve(ok)
}

export function ConfirmDialogHost() {
  const { t } = useLocale()
  const pending = useConfirmStore((state) => state.pending)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Focus a button on open, give focus back to whatever had it on close.
  useEffect(() => {
    if (!pending) return
    const previous = document.activeElement as HTMLElement | null
    ;(pending.danger ? cancelRef : confirmRef).current?.focus()
    return () => previous?.focus?.()
  }, [pending])

  // Escape closes only this dialog: caught in the capture phase so the
  // Settings dialog or a page behind it doesn't react to the same key.
  useEffect(() => {
    if (!pending) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      settle(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pending])

  return (
    <Modal
      open={pending !== null}
      title={pending?.title ?? ''}
      onClose={() => settle(false)}
      className={`fh-confirm-dialog [z-index:1100] [&_.ds-modal-panel]:[width:min(420px,92vw)] [&_.ds-modal-footer]:[border-top:none] [&_.ds-modal-footer]:[padding-top:4px]${pending?.danger ? ' fh-confirm-danger [&_.fh-settings-panel-header_h2]:[color:var(--status-danger)]' : ''}`}
      footer={
        <>
          <Button ref={cancelRef} variant="outline" onClick={() => settle(false)}>
            {pending?.cancelLabel ?? t('confirm.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant={pending?.danger ? 'danger' : 'primary'}
            onClick={() => settle(true)}
          >
            {pending?.confirmLabel ?? t('confirm.ok')}
          </Button>
        </>
      }
    >
      {pending?.message && <div className="fh-confirm-message [color:var(--muted)] [font-size:0.92em] [line-height:1.5] [overflow-wrap:anywhere]">{pending.message}</div>}
    </Modal>
  )
}
