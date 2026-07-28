import type { NetlifyPluginOptions } from '@netlify/build'
import type { NextConfigComplete } from 'next/dist/server/config-shared.js'
import { beforeEach, describe, expect, test, TestContext } from 'vitest'

import { setImageConfig } from './image-cdn.js'
import { PluginContext, type RequiredServerFilesManifest } from './plugin-context.js'

type ImageCDNTestContext = TestContext & {
  pluginContext: PluginContext
}

describe('Image CDN', () => {
  beforeEach<ImageCDNTestContext>((ctx) => {
    ctx.pluginContext = new PluginContext({
      netlifyConfig: {
        redirects: [],
      },
    } as unknown as NetlifyPluginOptions)
  })

  test<ImageCDNTestContext>('adds redirect to Netlify Image CDN when default image loader is used', async (ctx) => {
    ctx.pluginContext._requiredServerFiles = {
      config: {
        images: {
          path: '/_next/image',
          loader: 'default',
        },
      } as NextConfigComplete,
    } as RequiredServerFilesManifest

    await setImageConfig(ctx.pluginContext)

    expect(
      ctx.pluginContext.netlifyConfig.redirects.filter(({ from }) => from === '/_next/image'),
    ).toEqual([
      {
        from: '/_next/image',
        // eslint-disable-next-line id-length
        query: { q: ':quality', url: ':url', w: ':width' },
        to: '/.netlify/images?url=:url&w=:width&q=:quality',
        status: 200,
      },
      {
        from: '/_next/image',
        to: '/.netlify/images',
        status: 200,
      },
    ])
  })

  test<ImageCDNTestContext>('does not add redirect to Netlify Image CDN when non-default loader is used', async (ctx) => {
    ctx.pluginContext._requiredServerFiles = {
      config: {
        images: {
          path: '/_next/image',
          loader: 'custom',
          loaderFile: './custom-loader.js',
        },
      } as NextConfigComplete,
    } as RequiredServerFilesManifest

    await setImageConfig(ctx.pluginContext)

    expect(ctx.pluginContext.netlifyConfig.redirects).not.toEqual(
      expect.arrayContaining([
        {
          from: '/_next/image',
          // eslint-disable-next-line id-length
          query: { q: ':quality', url: ':url', w: ':width' },
          to: '/.netlify/images?url=:url&w=:width&q=:quality',
          status: 200,
        },
      ]),
    )
  })

  test<ImageCDNTestContext>('handles custom images.path', async (ctx) => {
    ctx.pluginContext._requiredServerFiles = {
      config: {
        images: {
          // Next.js automatically adds basePath to images.path (when user does not set custom `images.path` in their config)
          // if user sets custom `images.path` - it will be used as-is (so user need to cover their basePath by themselves
          // if they want to have it in their custom image endpoint
          // see https://github.com/vercel/next.js/blob/bb105ef4fbfed9d96a93794eeaed956eda2116d8/packages/next/src/server/config.ts#L426-L432)
          // either way `images.path` we get is final config with everything combined so we want to use it as-is
          path: '/base/path/_custom/image/endpoint',
          loader: 'default',
        },
      } as NextConfigComplete,
    } as RequiredServerFilesManifest

    await setImageConfig(ctx.pluginContext)

    expect(ctx.pluginContext.netlifyConfig.redirects).toEqual(
      expect.arrayContaining([
        {
          from: '/base/path/_custom/image/endpoint',
          // eslint-disable-next-line id-length
          query: { q: ':quality', url: ':url', w: ':width' },
          to: '/.netlify/images?url=:url&w=:width&q=:quality',
          status: 200,
        },
      ]),
    )
  })
})
