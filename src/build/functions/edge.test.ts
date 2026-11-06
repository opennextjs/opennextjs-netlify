import { describe, expect, test } from 'vitest'

import type { PluginContext } from '../plugin-context.js'

import { augmentMatchers, getCaseInsensitiveLocaleRegExpSource } from './edge.js'

// matchers produced by Next.js for `matcher: ['/admin/:path*', '/api/:path*']` with i18n enabled
const i18nMatchers = [
  {
    regexp:
      '^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/((?!_next\\/)[^/.]{1,}))\\/admin(?:\\/((?:[^\\/#\\?]+?)(?:\\/(?:[^\\/#\\?]+?))*))?(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$',
    originalSource: '/admin/:path*',
  },
  {
    regexp:
      '^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/((?!_next\\/)[^/.]{1,}))\\/api(?:\\/((?:[^\\/#\\?]+?)(?:\\/(?:[^\\/#\\?]+?))*))?(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$',
    originalSource: '/api/:path*',
  },
]

const createContext = (locales: string[]) =>
  ({
    buildConfig: { i18n: { locales, defaultLocale: locales[0] } },
  }) as unknown as PluginContext

const matchesAny = (patterns: string[], path: string) =>
  patterns.some((pattern) => new RegExp(pattern).test(path))

describe('getCaseInsensitiveLocaleRegExpSource', () => {
  test('creates case-insensitive character classes for letters', () => {
    expect(getCaseInsensitiveLocaleRegExpSource('en')).toBe('[eE][nN]')
    expect(getCaseInsensitiveLocaleRegExpSource('en-US')).toBe('[eE][nN]-[uU][sS]')
    expect(getCaseInsensitiveLocaleRegExpSource('zh_Hant.1')).toBe('[zZ][hH]_[hH][aA][nN][tT]\\.1')
  })
})

describe('augmentMatchers', () => {
  test('matches configured locales case-insensitively', () => {
    const patterns = augmentMatchers(i18nMatchers, createContext(['en', 'fr', 'en-US'])).map(
      (matcher) => matcher.regexp,
    )

    for (const path of [
      '/admin/secret',
      '/en/admin/secret',
      '/EN/admin/secret',
      '/Fr/admin/secret',
      '/en-US/admin/secret',
      '/en-us/admin/secret',
      '/EN-US/admin/secret',
      '/api/secret',
      '/en/api/secret',
      '/EN/api/secret',
      '/_next/data/build-id/en/admin/secret.json',
      '/_next/data/build-id/EN/admin/secret.json',
      '/_next/data/build-id/en-us/admin/secret.json',
    ]) {
      expect(matchesAny(patterns, path), `should match ${path}`).toBe(true)
    }

    for (const path of ['/de/admin/secret', '/foo/admin/secret', '/secret', '/en/secret']) {
      expect(matchesAny(patterns, path), `should not match ${path}`).toBe(false)
    }
  })
})
