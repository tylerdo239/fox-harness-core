// crypto.randomUUID exists only in a secure context (HTTPS or localhost): a page served over plain HTTP — staging,
// 2026-10-14 — has crypto.getRandomValues but no randomUUID, and calling it threw inside the chat's frame handler.
// These ids only key list entries and uploads, so a v4 UUID built from getRandomValues does the same job.
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
