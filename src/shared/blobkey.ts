import { Buffer } from 'node:buffer'
// need to import this since globalThis.crypto isn't available on Node 18
import { webcrypto as crypto } from 'node:crypto'

const maxLength = 180

/**
 * Routes can reach `encodeBlobKey` either percent-encoded or as raw Unicode. Decoding first
 * ensures both forms produce the same blob key. If decoding fails because the route contains a
 * literal `%` (e.g. `/50%-off`), we fall back to the original value so valid routes continue to
 * work instead of throwing `URIError`.
 */
function decodeKeyForConsistentEncoding(key: string): string {
  try {
    return decodeURIComponent(key)
  } catch {
    return key
  }
}

/**
 * Takes a blob key and returns a safe key for the file system.
 * The returned key is a base64url encoded string with a maximum length of 180 characters.
 * Longer keys are truncated and appended with a hash to ensure uniqueness.
 */
export async function encodeBlobKey(key: string): Promise<string> {
  const buffer = Buffer.from(decodeKeyForConsistentEncoding(key))
  const base64 = buffer.toString('base64url')
  if (base64.length <= maxLength) {
    return base64
  }

  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const hash = Buffer.from(digest).toString('base64url')

  return `${base64.slice(0, maxLength - hash.length - 1)}-${hash}`
}
