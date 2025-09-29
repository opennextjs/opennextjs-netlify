import type { NetlifyAdapterContext, OnBuildCompleteContext } from './types.js'

export async function onBuildComplete(
  nextAdapterContext: OnBuildCompleteContext,
  netlifyAdapterContext: NetlifyAdapterContext,
) {
  netlifyAdapterContext.frameworksAPIConfig ??= {}
  netlifyAdapterContext.frameworksAPIConfig.headers ??= []

  netlifyAdapterContext.frameworksAPIConfig.headers.push({
    for: `${nextAdapterContext.config.basePath}/_next/static/*`,
    values: {
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })

  // TODO: we should apply ctx.routes.headers here as well, but the matching
  // is currently not compatible with anything we can express with our redirect engine
  // {
  //   regex: "^(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$"
  //   source: "/:path*" // <- this is defined in next.config
  // }
  // per https://docs.netlify.com/manage/routing/headers/#wildcards-and-placeholders-in-paths
  // this is example of something we can't currently do
}
