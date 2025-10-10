import { describe, expect, it } from 'vitest'

import { BlobType, HtmlBlob, isHtmlBlob, isTagManifest, TagManifest } from './blob-types.cjs'

describe('isTagManifest', () => {
  it(`returns true for TagManifest instance`, () => {
    const value: TagManifest = { staleAt: 0, expiredAt: 0 }
    expect(isTagManifest(value)).toBe(true)
  })

  it(`returns false for non-TagManifest instance`, () => {
    const value: BlobType = { html: '', isFullyStaticPage: false }
    expect(isTagManifest(value)).toBe(false)
  })
})

describe('isHtmlBlob', () => {
  it(`returns true for HtmlBlob instance`, () => {
    const value: HtmlBlob = { html: '', isFullyStaticPage: false }
    expect(isHtmlBlob(value)).toBe(true)
  })

  it(`returns false for non-HtmlBlob instance`, () => {
    const value: BlobType = { staleAt: 0, expiredAt: 0 }
    expect(isHtmlBlob(value)).toBe(false)
  })
})
