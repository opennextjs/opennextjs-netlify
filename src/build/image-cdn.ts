import { fileURLToPath } from 'node:url'

import type { RemotePattern } from 'next/dist/shared/lib/image-config.js'
import { makeRe } from 'picomatch'

import { PluginContext } from './plugin-context.js'

// Use new URL() + fileURLToPath instead of import.meta.resolve for Vitest compatibility
// (Vitest does not support import.meta.resolve — see https://github.com/vitest-dev/vitest/issues/6953)
export const NETLIFY_IMAGE_LOADER_FILE = fileURLToPath(
  new URL(`../shared/netlify-image-cdn-next-image-loader.cjs`, import.meta.url),
)

function generateRegexFromPattern(pattern: string): string {
  return makeRe(pattern).source
}

/**
 * Rewrite next/image to netlify image cdn
 */
export const setImageConfig = async (ctx: PluginContext): Promise<void> => {
  const {
    images: {
      domains,
      remotePatterns,
      path: imageEndpointPath,
      loader: imageLoader,
      loaderFile: imageLoaderFile,
    },
  } = await ctx.buildConfig

  const usingNetlifyImageLoader =
    imageLoader === 'custom' && imageLoaderFile === NETLIFY_IMAGE_LOADER_FILE
  if (imageLoader !== 'default' && !usingNetlifyImageLoader) {
    return
  }

  // when migrating from @netlify/plugin-nextjs@5 that is not using loader image /_next/image might be cached in the browser,
  // so we need to keep it
  ctx.netlifyConfig.redirects.push(
    {
      from: imageEndpointPath,
      // w and q are too short to be used as params with id-length rule
      // but we are forced to do so because of the next/image loader decides on their names
      // eslint-disable-next-line id-length
      query: { url: ':url', w: ':width', q: ':quality' },
      to: '/.netlify/images?url=:url&w=:width&q=:quality',
      status: 200,
    },
    // when migrating from @netlify/plugin-nextjs@4 image redirect to ipx might be cached in the browser
    {
      from: '/_ipx/*',
      // w and q are too short to be used as params with id-length rule
      // but we are forced to do so because of the next/image loader decides on their names
      // eslint-disable-next-line id-length
      query: { url: ':url', w: ':width', q: ':quality' },
      to: '/.netlify/images?url=:url&w=:width&q=:quality',
      status: 200,
    },
  )

  if (remotePatterns?.length !== 0 || domains?.length !== 0) {
    ctx.netlifyConfig.images ||= { remote_images: [] }
    ctx.netlifyConfig.images.remote_images ||= []

    if (remotePatterns && remotePatterns.length !== 0) {
      for (const remotePattern of remotePatterns) {
        let { protocol, hostname, port, pathname }: RemotePattern = remotePattern

        if (pathname) {
          pathname = pathname.startsWith('/') ? pathname : `/${pathname}`
        }

        const combinedRemotePattern = `${protocol ?? 'http?(s)'}://${hostname}${
          port ? `:${port}` : ''
        }${pathname ?? '/**'}`

        try {
          ctx.netlifyConfig.images.remote_images.push(
            generateRegexFromPattern(combinedRemotePattern),
          )
        } catch (error) {
          ctx.failBuild(
            `Failed to generate Image CDN remote image regex from Next.js remote pattern: ${JSON.stringify(
              { remotePattern, combinedRemotePattern },
              null,
              2,
            )}`,
            error,
          )
        }
      }
    }

    if (domains && domains.length !== 0) {
      for (const domain of domains) {
        const patternFromDomain = `http?(s)://${domain}/**`
        try {
          ctx.netlifyConfig.images.remote_images.push(generateRegexFromPattern(patternFromDomain))
        } catch (error) {
          ctx.failBuild(
            `Failed to generate Image CDN remote image regex from Next.js domain: ${JSON.stringify(
              { domain, patternFromDomain },
              null,
              2,
            )}`,
            error,
          )
        }
      }
    }
  }
}
