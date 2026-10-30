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
  className,
  children,
}: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  footer?: ReactNode
  className?: string
  children?: ReactNode
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
    <div className={`fh-settings-dialog fixed [inset:0] [z-index:1000] flex items-center justify-center ds-modal${className ? ` ${className}` : ''}`}>
      <div className="fh-settings-mask absolute [inset:0] [background:var(--overlay-mask)] [backdrop-filter:blur(2px)]" onClick={onClose} />
      <div className="fh-settings-panel relative flex flex-col [background:var(--bg)] [border:1px_solid_var(--border)] [border-radius:24px] [box-shadow:var(--shadow-lv3)] ds-modal-panel [width:min(520px,92vw)] [height:auto] [max-height:86vh]" role="dialog" aria-modal="true" aria-label={title}>
        <div className="fh-settings-panel-header flex-none flex items-center justify-between [padding:0.75em_1em] [border-bottom:1px_solid_var(--border)] [&_h2]:m-0 [&_h2]:[font:var(--fh-text-l,500_1.4em/1.4_inherit)]">
          <h2>{title}</h2>
          <IconButton variant="plain" className="fh-settings-close" onClick={onClose}>
            <CloseIcon size={14} />
          </IconButton>
        </div>
        <div className="ds-modal-body [flex:1] min-h-0 overflow-y-auto [padding:14px_18px]">
          {description && <p className="ds-modal-desc [margin:0_0_12px] [color:var(--muted)] [font-size:0.9em]">{description}</p>}
          {children}
        </div>
        {footer && <div className="ds-modal-footer [&_button]:inline-flex [&_button]:items-center [&_button]:[gap:6px] [&_button]:whitespace-nowrap flex-none flex justify-end [gap:8px] [padding:12px_18px] [border-top:1px_solid_var(--border)]">{footer}</div>}
      </div>
    </div>
  )
}
