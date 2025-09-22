import { PluginContext } from './plugin-context.js'

/**
 * Rewrite next/image to netlify image cdn
 */
export const setLegacyIpxRewrite = async (ctx: PluginContext): Promise<void> => {
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
}
