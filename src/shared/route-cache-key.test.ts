import { describe, expect, it } from 'vitest'

import {
  getOwnerSourceRoute,
  getRouteCacheKey,
  isRouteCacheKey,
  normalizePagePath,
  routeCacheKeyToPathname,
} from './route-cache-key.cjs'

// Golden values: sha256 of the source route, matching Next's `getRouteCacheKey`.
const HASH = {
  '/post/[id]': '09edea6578dc15fcd7d6df2bcd486efc2ece8a5590361953fd11cdce81823538',
  '/[...slug]': '56e07328e560abf1d589b5ba82b2370cb06fcb0cd162a176c7cd2eca5c2a4633',
  '/': '8a5edab282632443219e051e4ade2d1d5bbc671c781051bf1437897cbdfea0f1',
}

describe('getRouteCacheKey', () => {
  it('scopes a Pages route by owner hash and normalized pathname', () => {
    expect(getRouteCacheKey('/post/1', { kind: 'PAGES', sourceRoute: '/post/[id]' })).toBe(
      `/route-cache/PAGES/${HASH['/post/[id]']}/$/post/1`,
    )
  })

  it('normalizes the home page pathname to /index', () => {
    expect(getRouteCacheKey('/', { kind: 'PAGES', sourceRoute: '/' })).toBe(
      `/route-cache/PAGES/${HASH['/']}/$/index`,
    )
  })

  it('uses the App page kind and a catch-all owner', () => {
    expect(getRouteCacheKey('/anything', { kind: 'APP_PAGE', sourceRoute: '/[...slug]' })).toBe(
      `/route-cache/APP_PAGE/${HASH['/[...slug]']}/$/anything`,
    )
  })
})

describe('getOwnerSourceRoute', () => {
  it('leaves Pages Router source routes unchanged', () => {
    expect(getOwnerSourceRoute('/post/[id]', 'PAGES')).toBe('/post/[id]')
    expect(getOwnerSourceRoute('/', 'PAGES')).toBe('/')
  })

  it('appends the App Router module segment suffix', () => {
    expect(getOwnerSourceRoute('/posts/[id]', 'APP_PAGE')).toBe('/posts/[id]/page')
    expect(getOwnerSourceRoute('/api/revalidate-handler', 'APP_ROUTE')).toBe(
      '/api/revalidate-handler/route',
    )
    expect(getOwnerSourceRoute('/', 'APP_PAGE')).toBe('/page')
  })
})

describe('normalizePagePath', () => {
  it('maps root to /index and leaves other paths', () => {
    expect(normalizePagePath('/')).toBe('/index')
    expect(normalizePagePath('/post/1')).toBe('/post/1')
    expect(normalizePagePath('/[...slug]')).toBe('/[...slug]')
  })
})

describe('routeCacheKeyToPathname', () => {
  it('recovers the pathname from a scoped key', () => {
    expect(routeCacheKeyToPathname(`/route-cache/PAGES/${HASH['/post/[id]']}/$/post/1`)).toBe(
      '/post/1',
    )
  })

  it('maps the scoped root back to /', () => {
    expect(routeCacheKeyToPathname(`/route-cache/PAGES/${HASH['/']}/$/index`)).toBe('/')
  })

  it('returns a plain (unscoped) key unchanged', () => {
    expect(routeCacheKeyToPathname('/post/1')).toBe('/post/1')
    expect(isRouteCacheKey('/post/1')).toBe(false)
  })
})
