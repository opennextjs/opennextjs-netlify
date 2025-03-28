import { describe, expect, it } from 'vitest'

import { BlobType, HtmlBlob, isHtmlBlob, isTagManifest, TagManifest } from './blob-types.cjs'

describe('isTagManifest', () => {
  it(`returns true for TagManifest instance`, () => {
    const value: TagManifest = { revalidatedAt: 0 }
    expect(isTagManifest(value)).toBe(true)
  })

  it(`returns false for non-TagManifest instance`, () => {
    const value: BlobType = { html: '', isFallback: false }
    expect(isTagManifest(value)).toBe(false)
  })
})

describe('isHtmlBlob', () => {
  it(`returns true for HtmlBlob instance`, () => {
    const value: HtmlBlob = { html: '', isFallback: false }
    expect(isHtmlBlob(value)).toBe(true)
  })

  it(`returns false for non-HtmlBlob instance`, () => {
    const value: BlobType = { revalidatedAt: 0 }
    expect(isHtmlBlob(value)).toBe(false)
  })
})
