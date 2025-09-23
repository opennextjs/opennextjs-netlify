import { fileURLToPath } from 'node:url'

import type { RemotePattern } from 'next-with-adapters/dist/shared/lib/image-config.js'
import { makeRe } from 'picomatch'

import type { FrameworksAPIConfig, NextConfigComplete, OnBuildCompleteContext } from './types.js'

const NETLIFY_IMAGE_LOADER_FILE = fileURLToPath(import.meta.resolve(`./next-image-loader.cjs`))

export function modifyConfig(config: NextConfigComplete) {
  if (config.images.loader === 'default') {
    // Set up Netlify Image CDN image's loaderFile
    // see https://nextjs.org/docs/app/api-reference/config/next-config-js/images
    config.images.loader = 'custom'
    config.images.loaderFile = NETLIFY_IMAGE_LOADER_FILE
  }
}

function generateRegexFromPattern(pattern: string): string {
  return makeRe(pattern).source
}

export function onBuildComplete(
  ctx: OnBuildCompleteContext,
  frameworksAPIConfigArg: FrameworksAPIConfig,
) {
  const frameworksAPIConfig: FrameworksAPIConfig = frameworksAPIConfigArg ?? {}

  // when migrating from @netlify/plugin-nextjs@4 image redirect to ipx might be cached in the browser
  frameworksAPIConfig.redirects ??= []
  frameworksAPIConfig.redirects.push({
    from: '/_ipx/*',
    // w and q are too short to be used as params with id-length rule
    // but we are forced to do so because of the next/image loader decides on their names
    // eslint-disable-next-line id-length
    query: { url: ':url', w: ':width', q: ':quality' },
    to: '/.netlify/images?url=:url&w=:width&q=:quality',
    status: 200,
  })

  const { images } = ctx.config
  if (images.loader === 'custom' && images.loaderFile === NETLIFY_IMAGE_LOADER_FILE) {
    const { remotePatterns, domains } = images
    // if Netlify image loader is used, configure allowed remote image sources
    const remoteImageSources: string[] = []
    if (remotePatterns && remotePatterns.length !== 0) {
      // convert images.remotePatterns to regexes for Frameworks API
      for (const remotePattern of remotePatterns) {
        if (remotePattern instanceof URL) {
          // Note: even if URL notation is used in next.config.js, This will result in RemotePattern
          // object here, so types for the complete config should not have URL as an possible type
          throw new TypeError('Received not supported URL instance in remotePatterns')
        }
        let { protocol, hostname, port, pathname }: RemotePattern = remotePattern

        if (pathname) {
          pathname = pathname.startsWith('/') ? pathname : `/${pathname}`
        }

        const combinedRemotePattern = `${protocol ?? 'http?(s)'}://${hostname}${
          port ? `:${port}` : ''
        }${pathname ?? '/**'}`

        try {
          remoteImageSources.push(generateRegexFromPattern(combinedRemotePattern))
        } catch (error) {
          throw new Error(
            `Failed to generate Image CDN remote image regex from Next.js remote pattern: ${JSON.stringify(
              { remotePattern, combinedRemotePattern },
              null,
              2,
            )}`,
            {
              cause: error,
            },
          )
        }
      }
    }

    if (domains && domains.length !== 0) {
      for (const domain of domains) {
        const patternFromDomain = `http?(s)://${domain}/**`
        try {
          remoteImageSources.push(generateRegexFromPattern(patternFromDomain))
        } catch (error) {
          throw new Error(
            `Failed to generate Image CDN remote image regex from Next.js domain: ${JSON.stringify(
              { domain, patternFromDomain },
              null,
              2,
            )}`,
            { cause: error },
          )
        }
      }
    }

    if (remoteImageSources.length !== 0) {
      // https://docs.netlify.com/build/frameworks/frameworks-api/#images
      frameworksAPIConfig.images ??= { remote_images: [] }
      frameworksAPIConfig.images.remote_images = remoteImageSources
    }
  }
  return frameworksAPIConfig
}
