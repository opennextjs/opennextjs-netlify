import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { encodeBlobKey } from './blobkey.js'

describe('encodeBlobKey', () => {
  const longKey = 'long'.repeat(100)

  it('truncates long keys to 180 characters', async () => {
    expect(await encodeBlobKey(longKey)).toHaveLength(180)
  })

  it('adds a differentiating hash to truncated keys', async () => {
    expect(await encodeBlobKey(`${longKey}a`)).not.toEqual(await encodeBlobKey(`${longKey}b`))
  })

  it('truncated keys keep having a readable start', async () => {
    const key = await encodeBlobKey(`/products/${longKey}`)
    expect(Buffer.from(key, 'base64url').toString().startsWith('/products/')).toBe(true)
  })

  it('produces the same key for a percent-encoded route and its decoded equivalent', async () => {
    expect(await encodeBlobKey('/caf%C3%A9')).toEqual(await encodeBlobKey('/café'))
  })

  it('falls back to the raw key (without throwing) when it is not validly percent-encoded', async () => {
    expect(await encodeBlobKey('/50%-off')).toEqual(Buffer.from('/50%-off').toString('base64url'))
  })
})
