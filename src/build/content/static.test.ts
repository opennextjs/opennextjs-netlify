import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'

import type { NetlifyPluginOptions } from '@netlify/build'
import glob from 'fast-glob'
import type { PrerenderManifest } from 'next/dist/build/index.js'
import { beforeEach, describe, expect, Mock, test, vi } from 'vitest'

import { decodeBlobKey, encodeBlobKey, mockFileSystem } from '../../../tests/index.js'
import { type FixtureTestContext } from '../../../tests/utils/contexts.js'
import { createFsFixture } from '../../../tests/utils/fixture.js'
import { HtmlBlob } from '../../shared/blob-types.cjs'
import { PluginContext, RequiredServerFilesManifest } from '../plugin-context.js'

import { copyStaticContent } from './static.js'

type Context = FixtureTestContext & {
  pluginContext: PluginContext
  publishDir: string
  relativeAppDir: string
}
const createFsFixtureWithBasePath = (
  fixture: Record<string, string>,
  ctx: Omit<Context, 'pluginContext'>,
  {
    basePath = '',
    // eslint-disable-next-line unicorn/no-useless-undefined
    i18n = undefined,
    dynamicRoutes = {},
    pagesManifest = {},
  }: {
    basePath?: string
    i18n?: Pick<NonNullable<RequiredServerFilesManifest['config']['i18n']>, 'locales'>
    dynamicRoutes?: {
      [route: string]: Pick<PrerenderManifest['dynamicRoutes'][''], 'fallback'>
    }
    pagesManifest?: Record<string, string>
  } = {},
) => {
  return createFsFixture(
    {
      ...fixture,
      [join(ctx.publishDir, 'routes-manifest.json')]: JSON.stringify({ basePath }),
      [join(ctx.publishDir, 'required-server-files.json')]: JSON.stringify({
        relativeAppDir: ctx.relativeAppDir,
        appDir: ctx.relativeAppDir,
        config: {
          distDir: ctx.publishDir,
          i18n,
        },
      } as Pick<RequiredServerFilesManifest, 'relativeAppDir' | 'appDir'>),
      [join(ctx.publishDir, 'prerender-manifest.json')]: JSON.stringify({ dynamicRoutes }),
      [join(ctx.publishDir, 'server', 'pages-manifest.json')]: JSON.stringify(pagesManifest),
    },
    ctx,
  )
}

async function readDirRecursive(dir: string) {
  const posixPaths = await glob('**/*', { cwd: dir, dot: true, absolute: true })
  // glob always returns unix-style paths, even on Windows!
  // To compare them more easily in our tests running on Windows, we convert them to the platform-specific paths.
  const paths = posixPaths.map((posixPath) => join(posixPath))
  return paths
}

let failBuildMock: Mock<PluginContext['utils']['build']['failBuild']>

const dontFailTest: PluginContext['utils']['build']['failBuild'] = () => {
  return undefined as never
}

describe('Regular Repository layout', () => {
  beforeEach<Context>((ctx) => {
    failBuildMock = vi.fn((msg, err) => {
      expect.fail(`failBuild should not be called, was called with ${inspect({ msg, err })}`)
    })
    ctx.publishDir = '.next'
    ctx.relativeAppDir = ''
    ctx.pluginContext = new PluginContext({
      constants: {
        PUBLISH_DIR: ctx.publishDir,
      },
      utils: {
        build: {
          failBuild: failBuildMock,
        } as unknown,
      },
    } as NetlifyPluginOptions)
  })

  describe('should copy the static pages to the publish directory if there are no corresponding JSON files and mark wether html file is a fully static pages router page', () => {
    test<Context>('no i18n', async ({ pluginContext, ...ctx }) => {
      await createFsFixtureWithBasePath(
        {
          '.next/server/pages/test.html': '',
          '.next/server/pages/test2.html': '',
          '.next/server/pages/test3.html': '',
          '.next/server/pages/test3.json': '',
          '.next/server/pages/blog/[slug].html': '',
        },
        ctx,
        {
          dynamicRoutes: {
            '/blog/[slug]': {
              fallback: '/blog/[slug].html',
            },
          },
          pagesManifest: {
            '/blog/[slug]': 'pages/blog/[slug].js',
            '/test': 'pages/test.html',
            '/test2': 'pages/test2.html',
            '/test3': 'pages/test3.js',
          },
        },
      )

      await copyStaticContent(pluginContext)
      const files = await glob('**/*', { cwd: pluginContext.blobDir, dot: true })

      const expectedHtmlBlobs = ['blog/[slug].html', 'test.html', 'test2.html']
      const expectedFullyStaticPages = new Set(['test.html', 'test2.html'])

      expect(files.map((path) => decodeBlobKey(path)).sort()).toEqual(expectedHtmlBlobs)

      for (const page of expectedHtmlBlobs) {
        const expectedIsFullyStaticPage = expectedFullyStaticPages.has(page)

        const blob = JSON.parse(
          await readFile(join(pluginContext.blobDir, await encodeBlobKey(page)), 'utf-8'),
        ) as HtmlBlob

        expect(
          blob,
          `${page} should ${expectedIsFullyStaticPage ? '' : 'not '}be a fully static Page`,
        ).toEqual({
          html: '',
          isFullyStaticPage: expectedIsFullyStaticPage,
        })
      }
    })

    test<Context>('with i18n', async ({ pluginContext, ...ctx }) => {
      await createFsFixtureWithBasePath(
        {
          '.next/server/pages/de/test.html': '',
          '.next/server/pages/de/test2.html': '',
          '.next/server/pages/de/test3.html': '',
          '.next/server/pages/de/test3.json': '',
          '.next/server/pages/de/blog/[slug].html': '',
          '.next/server/pages/en/test.html': '',
          '.next/server/pages/en/test2.html': '',
          '.next/server/pages/en/test3.html': '',
          '.next/server/pages/en/test3.json': '',
          '.next/server/pages/en/blog/[slug].html': '',
        },
        ctx,
        {
          dynamicRoutes: {
            '/blog/[slug]': {
              fallback: '/blog/[slug].html',
            },
          },
          i18n: {
            locales: ['en', 'de'],
          },
          pagesManifest: {
            '/blog/[slug]': 'pages/blog/[slug].js',
            '/en/test': 'pages/en/test.html',
            '/de/test': 'pages/de/test.html',
            '/en/test2': 'pages/en/test2.html',
            '/de/test2': 'pages/de/test2.html',
            '/test3': 'pages/test3.js',
          },
        },
      )

      await copyStaticContent(pluginContext)
      const files = await glob('**/*', { cwd: pluginContext.blobDir, dot: true })

      const expectedHtmlBlobs = [
        'de/blog/[slug].html',
        'de/test.html',
        'de/test2.html',
        'en/blog/[slug].html',
        'en/test.html',
        'en/test2.html',
      ]
      const expectedFullyStaticPages = new Set([
        'en/test.html',
        'de/test.html',
        'en/test2.html',
        'de/test2.html',
      ])

      expect(files.map((path) => decodeBlobKey(path)).sort()).toEqual(expectedHtmlBlobs)

      for (const page of expectedHtmlBlobs) {
        const expectedIsFullyStaticPage = expectedFullyStaticPages.has(page)

        const blob = JSON.parse(
          await readFile(join(pluginContext.blobDir, await encodeBlobKey(page)), 'utf-8'),
        ) as HtmlBlob

        expect(
          blob,
          `${page} should ${expectedIsFullyStaticPage ? '' : 'not '}be a fully static Page`,
        ).toEqual({
          html: '',
          isFullyStaticPage: expectedIsFullyStaticPage,
        })
      }
    })
  })

  test<Context>('should not copy the static pages to the publish directory if there are corresponding JSON files', async ({
    pluginContext,
    ...ctx
  }) => {
    await createFsFixtureWithBasePath(
      {
        '.next/server/pages/test.html': '',
        '.next/server/pages/test.json': '',
        '.next/server/pages/test2.html': '',
        '.next/server/pages/test2.json': '',
      },
      ctx,
    )

    await copyStaticContent(pluginContext)
    expect(await glob('**/*', { cwd: pluginContext.blobDir, dot: true })).toHaveLength(0)
  })
})

describe('Mono Repository', () => {
  beforeEach<Context>((ctx) => {
    ctx.publishDir = 'apps/app-1/.next'
    ctx.relativeAppDir = 'apps/app-1'
    ctx.pluginContext = new PluginContext({
      constants: {
        PUBLISH_DIR: ctx.publishDir,
        PACKAGE_PATH: 'apps/app-1',
      },
      utils: { build: { failBuild: vi.fn() } as unknown },
    } as NetlifyPluginOptions)
  })

  describe('should copy the static pages to the publish directory if there are no corresponding JSON files and mark wether html file is a fully static pages router page', () => {
    test<Context>('no i18n', async ({ pluginContext, ...ctx }) => {
      await createFsFixtureWithBasePath(
        {
          'apps/app-1/.next/server/pages/test.html': '',
          'apps/app-1/.next/server/pages/test2.html': '',
          'apps/app-1/.next/server/pages/test3.html': '',
          'apps/app-1/.next/server/pages/test3.json': '',
          'apps/app-1/.next/server/pages/blog/[slug].html': '',
        },
        ctx,
        {
          dynamicRoutes: {
            '/blog/[slug]': {
              fallback: '/blog/[slug].html',
            },
          },
          pagesManifest: {
            '/blog/[slug]': 'pages/blog/[slug].js',
            '/test': 'pages/test.html',
            '/test2': 'pages/test2.html',
            '/test3': 'pages/test3.js',
          },
        },
      )

      await copyStaticContent(pluginContext)
      const files = await glob('**/*', { cwd: pluginContext.blobDir, dot: true })

      const expectedHtmlBlobs = ['blog/[slug].html', 'test.html', 'test2.html']
      const expectedFullyStaticPages = new Set(['test.html', 'test2.html'])

      expect(files.map((path) => decodeBlobKey(path)).sort()).toEqual(expectedHtmlBlobs)

      for (const page of expectedHtmlBlobs) {
        const expectedIsFullyStaticPage = expectedFullyStaticPages.has(page)

        const blob = JSON.parse(
          await readFile(join(pluginContext.blobDir, await encodeBlobKey(page)), 'utf-8'),
        ) as HtmlBlob

        expect(
          blob,
          `${page} should ${expectedIsFullyStaticPage ? '' : 'not '}be a fully static Page`,
        ).toEqual({
          html: '',
          isFullyStaticPage: expectedIsFullyStaticPage,
        })
      }
    })

    test<Context>('with i18n', async ({ pluginContext, ...ctx }) => {
      await createFsFixtureWithBasePath(
        {
          'apps/app-1/.next/server/pages/de/test.html': '',
          'apps/app-1/.next/server/pages/de/test2.html': '',
          'apps/app-1/.next/server/pages/de/test3.html': '',
          'apps/app-1/.next/server/pages/de/test3.json': '',
          'apps/app-1/.next/server/pages/de/blog/[slug].html': '',
          'apps/app-1/.next/server/pages/en/test.html': '',
          'apps/app-1/.next/server/pages/en/test2.html': '',
          'apps/app-1/.next/server/pages/en/test3.html': '',
          'apps/app-1/.next/server/pages/en/test3.json': '',
          'apps/app-1/.next/server/pages/en/blog/[slug].html': '',
        },
        ctx,
        {
          dynamicRoutes: {
            '/blog/[slug]': {
              fallback: '/blog/[slug].html',
            },
          },
          i18n: {
            locales: ['en', 'de'],
          },
          pagesManifest: {
            '/blog/[slug]': 'pages/blog/[slug].js',
            '/en/test': 'pages/en/test.html',
            '/de/test': 'pages/de/test.html',
            '/en/test2': 'pages/en/test2.html',
            '/de/test2': 'pages/de/test2.html',
            '/test3': 'pages/test3.js',
          },
        },
      )

      await copyStaticContent(pluginContext)
      const files = await glob('**/*', { cwd: pluginContext.blobDir, dot: true })

      const expectedHtmlBlobs = [
        'de/blog/[slug].html',
        'de/test.html',
        'de/test2.html',
        'en/blog/[slug].html',
        'en/test.html',
        'en/test2.html',
      ]
      const expectedFullyStaticPages = new Set([
        'en/test.html',
        'de/test.html',
        'en/test2.html',
        'de/test2.html',
      ])

      expect(files.map((path) => decodeBlobKey(path)).sort()).toEqual(expectedHtmlBlobs)

      for (const page of expectedHtmlBlobs) {
        const expectedIsFullyStaticPage = expectedFullyStaticPages.has(page)

        const blob = JSON.parse(
          await readFile(join(pluginContext.blobDir, await encodeBlobKey(page)), 'utf-8'),
        ) as HtmlBlob

        expect(
          blob,
          `${page} should ${expectedIsFullyStaticPage ? '' : 'not '}be a fully static Page`,
        ).toEqual({
          html: '',
          isFullyStaticPage: expectedIsFullyStaticPage,
        })
      }
    })
  })

  test<Context>('should not copy the static pages to the publish directory if there are corresponding JSON files', async ({
    pluginContext,
    ...ctx
  }) => {
    await createFsFixtureWithBasePath(
      {
        'apps/app-1/.next/server/pages/test.html': '',
        'apps/app-1/.next/server/pages/test.json': '',
        'apps/app-1/.next/server/pages/test2.html': '',
        'apps/app-1/.next/server/pages/test2.json': '',
      },
      ctx,
    )

    await copyStaticContent(pluginContext)
    expect(await glob('**/*', { cwd: pluginContext.blobDir, dot: true })).toHaveLength(0)
  })
})
