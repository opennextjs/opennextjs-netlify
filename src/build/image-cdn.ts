import type { RemotePattern } from 'next/dist/shared/lib/image-config.js'
import { makeRe } from 'picomatch'

import { PluginContext } from './plugin-context.js'

function generateRegexFromPattern(pattern: string): string {
  return makeRe(pattern).source
}

/**
 * Rewrite next/image to netlify image cdn
 */
export const setImageConfig = async (ctx: PluginContext): Promise<void> => {
  const {
    images: { domains, remotePatterns, loader: imageLoader },
  } = await ctx.buildConfig
  if (imageLoader !== 'default') {
    return
  }

  ctx.netlifyConfig.redirects.push(
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
