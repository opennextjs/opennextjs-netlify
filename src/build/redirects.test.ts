import type { NetlifyPluginOptions } from '@netlify/build'
import type { RoutesManifest } from 'next/dist/build/index.js'
import { beforeEach, describe, expect, test, type TestContext, vi } from 'vitest'

import { PluginContext } from './plugin-context.js'
import { setRedirectsConfig } from './redirects.js'

type RedirectsTestContext = TestContext & {
  pluginContext: PluginContext
  routesManifest: RoutesManifest
}

describe('Redirects', () => {
  beforeEach<RedirectsTestContext>((ctx) => {
    ctx.routesManifest = {
      basePath: '',
      headers: [],
      rewrites: {
        beforeFiles: [],
        afterFiles: [],
        fallback: [],
      },
      redirects: [
        {
          source: '/old-page',
          destination: '/new-page',
          permanent: true,
        },
        {
          source: '/another-old-page',
          destination: '/another-new-page',
          statusCode: 301,
        },
        {
          source: '/external',
          destination: 'https://example.com',
          permanent: false,
        },
        {
          source: '/with-params/:slug',
          destination: '/news/:slug',
          permanent: true,
        },
        {
          source: '/splat/:path*',
          destination: '/new-splat/:path',
          permanent: true,
        },
        {
          source: '/old-blog/:slug(\\d{1,})',
          destination: '/news/:slug',
          permanent: true,
        },
        {
          source: '/missing',
          destination: '/somewhere',
          missing: [{ type: 'header', key: 'x-foo' }],
        },
        {
          source: '/has',
          destination: '/somewhere-else',
          has: [{ type: 'header', key: 'x-bar', value: 'baz' }],
        },
      ],
    }

    ctx.pluginContext = new PluginContext({
      netlifyConfig: {
        redirects: [],
      },
    } as unknown as NetlifyPluginOptions)

    vi.spyOn(ctx.pluginContext, 'getRoutesManifest').mockResolvedValue(ctx.routesManifest)
  })

  test<RedirectsTestContext>('creates redirects for simple cases', async (ctx) => {
    await setRedirectsConfig(ctx.pluginContext)
    expect(ctx.pluginContext.netlifyConfig.redirects).toEqual([
      {
        from: '/old-page',
        to: '/new-page',
        status: 308,
      },
      {
        from: '/another-old-page',
        to: '/another-new-page',
        status: 301,
      },
      {
        from: '/external',
        to: 'https://example.com',
        status: 307,
      },
      {
        from: '/with-params/:slug',
        to: '/news/:slug',
        status: 308,
      },
      {
        from: '/splat/*',
        to: '/new-splat/:splat',
        status: 308,
      },
    ])
  })

  test<RedirectsTestContext>('prepends basePath to redirects', async (ctx) => {
    ctx.routesManifest.basePath = '/docs'
    await setRedirectsConfig(ctx.pluginContext)
    expect(ctx.pluginContext.netlifyConfig.redirects).toEqual([
      {
        from: '/docs/old-page',
        to: '/docs/new-page',
        status: 308,
      },
      {
        from: '/docs/another-old-page',
        to: '/docs/another-new-page',
        status: 301,
      },
      {
        from: '/docs/external',
        to: 'https://example.com',
        status: 307,
      },
      {
        from: '/docs/with-params/:slug',
        to: '/docs/news/:slug',
        status: 308,
      },
      {
        from: '/docs/splat/*',
        to: '/docs/new-splat/:splat',
        status: 308,
      },
    ])
  })
})
