// navigator.clipboard exists only in a secure context (HTTPS or localhost); over plain HTTP — staging, 2026-10-14 —
// it is undefined and every copy button failed. There the old way still works: select a hidden textarea and run the
// "copy" command (deprecated but supported by every browser, and allowed during the click that calls this).
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.opacity = '0'
  // next to the button that was clicked: a dialog's focus trap would pull focus back from a textarea under <body>
  const host = document.activeElement?.parentElement ?? document.body
  const active = document.activeElement as HTMLElement | null
  host.appendChild(area)
  area.select()
  try {
    if (!document.execCommand('copy')) throw new Error('copy command refused')
  } finally {
    area.remove()
    active?.focus()
  }
}
