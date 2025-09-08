import { posix } from 'node:path'

import type { PluginContext } from './plugin-context.js'

// These are the characters that are not allowed in a simple redirect source.
// They are all special characters in a regular expression.
// eslint-disable-next-line unicorn/better-regex, no-useless-escape
const DISALLOWED_SOURCE_CHARACTERS = /[()\[\]{}?+|]/
const SPLAT_REGEX = /\/:(\w+)\*$/

/**
 * Adds redirects from the Next.js routes manifest to the Netlify config.
 */
export const setRedirectsConfig = async (ctx: PluginContext): Promise<void> => {
  const { redirects, basePath } = await ctx.getRoutesManifest()

  for (const redirect of redirects) {
    // We can only handle simple redirects that don't have complex conditions.
    if (redirect.has || redirect.missing) {
      continue
    }

    // We can't handle redirects with complex regex sources.
    if (DISALLOWED_SOURCE_CHARACTERS.test(redirect.source)) {
      continue
    }

    let from = redirect.source
    let to = redirect.destination

    const splatMatch = from.match(SPLAT_REGEX)
    if (splatMatch) {
      const [, param] = splatMatch
      from = from.replace(SPLAT_REGEX, '/*')
      to = to.replace(`/:${param}`, '/:splat')
    }

    const netlifyRedirect = {
      from: posix.join(basePath, from),
      to,
      status: redirect.statusCode || (redirect.permanent ? 308 : 307),
    }

    // External redirects should not have the basePath prepended.
    if (!to.startsWith('http')) {
      netlifyRedirect.to = posix.join(basePath, to)
    }

    ctx.netlifyConfig.redirects.push(netlifyRedirect)
  }
}
