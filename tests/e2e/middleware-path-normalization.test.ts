import { expect } from '@playwright/test'
import type { Fixture } from '../utils/create-e2e-fixture.js'
import { hasNodeMiddlewareSupport } from '../utils/next-version-helpers.mjs'
import { test } from '../utils/playwright-helpers.js'

// Middleware used in these tests is acting as an auth gate - it returns 401 for `/admin`, `/api`
// and `/:tenant/dash` paths when there is no `auth` cookie. Those tests ensure that it's not possible to get to gated content
// by using paths that are normalized differently by edge function routing and origin.

type ExtendedFixtures = {
  edgeOrNodeMiddlewarePathNormalization: Fixture
}

const expectBlocked = async (response: Response, path: string) => {
  const body = await response.text()
  expect(response.status, `${path} should be blocked by middleware`).toBe(401)
  expect(body, `${path} should be blocked by middleware`).toContain('BLOCKED-BY-MIDDLEWARE')
  expect(body).not.toContain('SECRET')
}

const fetchRaw = (baseUrl: string, path: string, init?: RequestInit) =>
  // fetch (WHATWG URL) preserves repeated slashes and casing in the path
  fetch(`${baseUrl}${path}`, { redirect: 'manual', ...init })

// Only the locale segment is matched case-insensitively by Next.js - routes themselves are case-sensitive.
// Middleware matchers don't match those paths either, so we check that gated content is not served
// even for authorized requests (so it's not middleware that is preventing access).
const expectNotFoundRegardlessOfAuth = async (baseUrl: string, paths: string[]) => {
  for (const path of paths) {
    for (const method of ['GET', 'POST']) {
      for (const headers of [{}, { cookie: 'auth=1' }]) {
        const response = await fetchRaw(baseUrl, path, { method, headers })
        const label = `${method} ${path}${'cookie' in headers ? ' (authorized)' : ''}`
        expect(response.status, `${label} should not be found`).toBe(404)
        expect(await response.text(), label).not.toContain('SECRET')
      }
    }
  }
}

for (const { label, testWithSwitchableMiddlewareRuntime } of [
  {
    label: 'Edge runtime middleware',
    testWithSwitchableMiddlewareRuntime: test.extend<{}, ExtendedFixtures>({
      edgeOrNodeMiddlewarePathNormalization: [
        async ({ middlewarePathNormalization }, use) => {
          await use(middlewarePathNormalization)
        },
        { scope: 'worker' },
      ],
    }),
  },
  hasNodeMiddlewareSupport()
    ? {
        label: 'Node.js runtime middleware',
        testWithSwitchableMiddlewareRuntime: test.extend<{}, ExtendedFixtures>({
          edgeOrNodeMiddlewarePathNormalization: [
            async ({ middlewarePathNormalizationNode }, use) => {
              await use(middlewarePathNormalizationNode)
            },
            { scope: 'worker' },
          ],
        }),
      }
    : undefined,
].filter(function isDefined<T>(argument: T | undefined): argument is T {
  return typeof argument !== 'undefined'
})) {
  const test = testWithSwitchableMiddlewareRuntime

  test.describe(`${label} - path-scoped matcher with i18n`, () => {
    test('allows authorized requests to reach gated content', async ({
      edgeOrNodeMiddlewarePathNormalization,
    }) => {
      for (const path of ['/admin/secret', '/api/secret', '/acme/dash/secret']) {
        const response = await fetchRaw(edgeOrNodeMiddlewarePathNormalization.url, path, {
          headers: { cookie: 'auth=1' },
        })
        expect(response.status, path).toBe(200)
        expect(await response.text(), path).toContain('SECRET')
      }
    })

    test('blocks gated paths regardless of locale casing', async ({
      edgeOrNodeMiddlewarePathNormalization,
    }) => {
      for (const path of [
        '/admin/secret',
        '/en/admin/secret',
        '/fr/admin/secret',
        '/EN/admin/secret',
        '/Fr/admin/secret',
        '/fR/admin/secret',
        '/en-US/admin/secret',
        '/en-us/admin/secret',
        '/EN-US/admin/secret',
        '/_next/data/build-id/en/admin/secret.json',
        '/_next/data/build-id/EN/admin/secret.json',
        '/_next/data/build-id/en-us/admin/secret.json',
      ]) {
        await expectBlocked(await fetchRaw(edgeOrNodeMiddlewarePathNormalization.url, path), path)
      }
    })

    test('does not serve gated content for paths with non-locale segments in different casing', async ({
      edgeOrNodeMiddlewarePathNormalization,
    }) => {
      await expectNotFoundRegardlessOfAuth(edgeOrNodeMiddlewarePathNormalization.url, [
        '/ADMIN/secret',
        '/EN/ADMIN/secret',
        '/_next/data/build-id/en/ADMIN/secret.json',
        '/API/secret',
        '/Api/secret',
        '/EN/API/secret',
      ])
    })

    test('blocks api paths with and without locale', async ({
      edgeOrNodeMiddlewarePathNormalization,
    }) => {
      for (const method of ['GET', 'POST']) {
        for (const path of ['/api/secret', '/en/api/secret', '/EN/api/secret']) {
          await expectBlocked(
            await fetchRaw(edgeOrNodeMiddlewarePathNormalization.url, path, { method }),
            `${method} ${path}`,
          )
        }
      }
    })

    test('blocks paths with encoded slash in dynamic segment', async ({
      edgeOrNodeMiddlewarePathNormalization,
    }) => {
      // Decoding `%2F` adds an empty segment (`/acme//dash`) which doesn't match `/:tenant/dash/:path*`,
      // but the page is still served (with `tenant` param set to `acme/`), so middleware must run.
      // Edge function routing and the URL edge function receives can differ depending on
      // platform path normalization, so we only check that gated content is not served.
      for (const path of [
        '/acme/dash/secret',
        '/acme%2F/dash/secret',
        '/acme%2Fx/dash/secret',
        '/acme:%2F/dash/secret',
        '/acme%3A%2F/dash/secret',
        '/en/acme%2F/dash/secret',
        '/EN/acme%2F/dash/secret',
        '/EN/acme:%2F/dash/secret',
        '/_next/data/build-id/en/acme%2F/dash/secret.json',
        '/_next/data/build-id/en/acme:%2F/dash/secret.json',
      ]) {
        await expectBlocked(await fetchRaw(edgeOrNodeMiddlewarePathNormalization.url, path), path)
      }
    })

    // Platform collapses repeated slashes before edge function matching (same as origin does),
    // so middleware runs for normalized path
    test('blocks paths with repeated slashes', async ({
      edgeOrNodeMiddlewarePathNormalization,
    }) => {
      for (const method of ['GET', 'POST']) {
        for (const path of [
          '//admin/secret',
          '///admin/secret',
          '/admin//secret',
          '//en/admin/secret',
          '/en//admin/secret',
          '//EN/admin/secret',
          '//api/secret',
          '/api//secret',
          '//acme/dash/secret',
          '/acme//dash/secret',
          '/_next/data//build-id/en/admin/secret.json',
          '/_next/data/build-id//en/admin/secret.json',
        ]) {
          await expectBlocked(
            await fetchRaw(edgeOrNodeMiddlewarePathNormalization.url, path, { method }),
            `${method} ${path}`,
          )
        }
      }
    })
  })
}

test.describe('Edge runtime middleware - catch-all matcher with gating in middleware code', () => {
  test('blocks gated paths unless authorized and passes normalized path to middleware', async ({
    middlewarePathNormalizationCatchAll,
  }) => {
    for (const path of ['/admin/secret', '/api/secret', '/acme/dash/secret']) {
      await expectBlocked(await fetchRaw(middlewarePathNormalizationCatchAll.url, path), path)

      const authorizedResponse = await fetchRaw(middlewarePathNormalizationCatchAll.url, path, {
        headers: { cookie: 'auth=1' },
      })
      expect(authorizedResponse.status, path).toBe(200)
      expect(await authorizedResponse.text(), path).toContain('SECRET')
    }

    const publicResponse = await fetchRaw(middlewarePathNormalizationCatchAll.url, '/')
    expect(publicResponse.status).toBe(200)
    expect(publicResponse.headers.get('x-middleware-seen-path')).toBe('/')
  })

  test('blocks paths with encoded slash in dynamic segment', async ({
    middlewarePathNormalizationCatchAll,
  }) => {
    for (const path of [
      '/acme%2F/dash/secret',
      '/acme:%2F/dash/secret',
      '/acme%3A%2F/dash/secret',
      '/_next/data/build-id/acme%2F/dash/secret.json',
      '/_next/data/build-id/acme:%2F/dash/secret.json',
    ]) {
      await expectBlocked(await fetchRaw(middlewarePathNormalizationCatchAll.url, path), path)
    }
  })

  test('does not serve gated content for paths in different casing', async ({
    middlewarePathNormalizationCatchAll,
  }) => {
    await expectNotFoundRegardlessOfAuth(middlewarePathNormalizationCatchAll.url, [
      '/ADMIN/secret',
      '/_next/data/build-id/ADMIN/secret.json',
      '/API/secret',
      '/Api/secret',
    ])
  })

  test('blocks paths with repeated slashes and passes normalized path to middleware', async ({
    middlewarePathNormalizationCatchAll,
  }) => {
    for (const path of [
      '//admin/secret',
      '///admin/secret',
      '//api/secret',
      '//acme/dash/secret',
      '/_next/data//build-id/admin/secret.json',
      '/_next/data/build-id//admin/secret.json',
    ]) {
      await expectBlocked(await fetchRaw(middlewarePathNormalizationCatchAll.url, path), path)
    }

    const response = await fetchRaw(middlewarePathNormalizationCatchAll.url, '//')
    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-seen-path')).toBe('/')
  })
})
