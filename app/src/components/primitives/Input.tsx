// Real primitive extracted 2026-09-10 — CSS for plain text/password/email
// inputs was ALREADY shared (one `input[type=...]` rule, style.css) before
// this; this wrapper exists for the JSX-level duplication instead (4 call
// sites each hand-writing the same `<label>{text}<input .../></label>`
// shape or a bare `<input>`), and so `ref` forwarding (the sidebar search
// input focuses itself programmatically) is handled once, correctly, not
// once per call site. `label` is optional — `ConnectForm`'s email/password
// fields pass one (rendered exactly as `#connect-form label` already
// expects: label text, then the input, both inside the `<label>`, no new
// wrapper element); the composer and sidebar-search inputs have none
// (placeholder-only, matching their current markup exactly).
import { forwardRef, type ComponentPropsWithoutRef } from 'react'

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<'input'> & { label?: string }>(
  function Input({ label, ...rest }, ref) {
    const input = <input {...rest} ref={ref} />
    if (!label) return input
    return (
      <label>
        {label}
        {input}
      </label>
    )
  },
)
