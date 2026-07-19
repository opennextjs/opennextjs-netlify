import { Buffer } from 'node:buffer'
// need to import this since globalThis.crypto isn't available on Node 18
import { webcrypto as crypto } from 'node:crypto'

const maxLength = 180

/**
 * Takes a blob key and returns a safe key for the file system.
 * The returned key is a base64url encoded string with a maximum length of 180 characters.
 * Longer keys are truncated and appended with a hash to ensure uniqueness.
 */
export async function encodeBlobKey(key: string): Promise<string> {
  const buffer = Buffer.from(decodeURIComponent(key))
  const base64 = buffer.toString('base64url')
  if (base64.length <= maxLength) {
    return base64
  }

  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const hash = Buffer.from(digest).toString('base64url')

  return `${base64.slice(0, maxLength - hash.length - 1)}-${hash}`
}
