// Tokens of connected ad accounts are stored sealed (docs/meta-ads-mcp-plan.md D9): AES-256-GCM, a fresh 12-byte iv
// each time, laid out iv | ciphertext | tag. The key comes from FOX_TOKEN_ENC_KEY(S), which only the gateway has — a
// database dump or backup alone gives no usable token. `key_id` on the row says which key sealed it, so a new key
// can be put first while old rows still open with the previous one.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { config } from '../config.ts'

export function encryptionReady(): boolean {
  const first = config.tokenEncKeys[0]
  return first !== undefined && first.key.length === 32
}

export function seal(plain: string): { data: Buffer; keyId: string } {
  const key = config.tokenEncKeys[0]
  if (!key || key.key.length !== 32) throw new Error('FOX_TOKEN_ENC_KEY is not set (32 bytes, base64)')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key.key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { data: Buffer.concat([iv, body, cipher.getAuthTag()]), keyId: key.id }
}

export function open(data: Buffer, keyId: string): string {
  const key = config.tokenEncKeys.find((entry) => entry.id === keyId)
  if (!key) throw new Error(`token key ${keyId} is not configured`)
  const decipher = createDecipheriv('aes-256-gcm', key.key, data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(data.length - 16))
  return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString('utf8')
}
