import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { NextAdapter } from 'next-with-adapters'
import type { RemotePattern } from 'next-with-adapters/dist/shared/lib/image-config.js'
import { makeRe } from 'picomatch'

const NETLIFY_FRAMEWORKS_API_CONFIG_PATH = '.netlify/v1/config.json'
const NETLIFY_IMAGE_LOADER_FILE = '@netlify/plugin-nextjs/dist/next-image-loader.cjs'

function generateRegexFromPattern(pattern: string): string {
  return makeRe(pattern).source
}

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config) {
    // Enable Next.js standalone mode at build time
    config.output = 'standalone'

    if (config.images.loader === 'default') {
      // Set up Netlify Image CDN image's loaderFile
      // see https://nextjs.org/docs/app/api-reference/config/next-config-js/images
      config.images.loader = 'custom'
      config.images.loaderFile = NETLIFY_IMAGE_LOADER_FILE
    }

    return config
  },
  async onBuildComplete(ctx) {
    console.log('onBuildComplete hook called')

    let frameworksAPIConfig: any = null
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
        frameworksAPIConfig ??= {}
        frameworksAPIConfig.images ??= {}
        frameworksAPIConfig.images.remote_images = remoteImageSources
      }
    }

    if (frameworksAPIConfig) {
      // write out config if there is any
      // https://docs.netlify.com/build/frameworks/frameworks-api/#netlifyv1configjson
      await mkdir(dirname(NETLIFY_FRAMEWORKS_API_CONFIG_PATH), { recursive: true })
      await writeFile(
        NETLIFY_FRAMEWORKS_API_CONFIG_PATH,
        JSON.stringify(frameworksAPIConfig, null, 2),
      )
    }
  },
}

export default adapter
