// A small centered dialog (mask + panel + title + body + footer) reusing the Settings dialog's mask/panel look
// (`.fh-settings-*` in style.css). Closes on mask click and Escape. Used by the Data Studio chart/dashboard
// dialogs (docs/data-studio-mongodb-plan.md — clone of the reference UI's Edit fields / Edit colors /
// Add to dashboard dialogs).
import { useEffect, type ReactNode } from 'react'

import { CloseIcon } from '../../icons.tsx'
import { IconButton } from './IconButton.tsx'

export function Modal({
  open,
  title,
  description,
  onClose,
  footer,
  children,
}: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fh-settings-dialog ds-modal">
      <div className="fh-settings-mask" onClick={onClose} />
      <div className="fh-settings-panel ds-modal-panel" role="dialog" aria-label={title}>
        <div className="fh-settings-panel-header">
          <h2>{title}</h2>
          <IconButton variant="plain" className="fh-settings-close" onClick={onClose}>
            <CloseIcon size={14} />
          </IconButton>
        </div>
        <div className="ds-modal-body">
          {description && <p className="ds-modal-desc">{description}</p>}
          {children}
        </div>
        {footer && <div className="ds-modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
