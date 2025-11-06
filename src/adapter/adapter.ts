import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { NextAdapter } from 'next-with-adapters'

import { NETLIFY_FRAMEWORKS_API_CONFIG_PATH } from './build/constants.js'
import { onBuildComplete as onBuildCompleteForHeaders } from './build/header.js'
import {
  modifyConfig as modifyConfigForImageCDN,
  onBuildComplete as onBuildCompleteForImageCDN,
} from './build/image-cdn.js'
import { onBuildComplete as onBuildCompleteForMiddleware } from './build/middleware.js'
import { createNetlifyAdapterContext } from './build/netlify-adapter-context.js'
import { onBuildComplete as onBuildCompleteForPagesAndAppHandlers } from './build/pages-and-app-handlers.js'
import { onBuildComplete as onBuildCompleteForRouting } from './build/routing.js'
import { onBuildComplete as onBuildCompleteForStaticAssets } from './build/static-assets.js'

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config) {
    if (config.output !== 'export') {
      // If not export, make sure to not build standalone output as it will become useless
      // @ts-expect-error types don't unsetting output to not use 'standalone'
      config.output = undefined
    }

    modifyConfigForImageCDN(config)

    return config
  },
  async onBuildComplete(nextAdapterContext) {
    // for dev/debugging purposes only
    await writeFile('./onBuildComplete.json', JSON.stringify(nextAdapterContext, null, 2))
    // debugger

    const netlifyAdapterContext = createNetlifyAdapterContext()

    await onBuildCompleteForImageCDN(nextAdapterContext, netlifyAdapterContext)
    await onBuildCompleteForMiddleware(nextAdapterContext, netlifyAdapterContext)
    await onBuildCompleteForStaticAssets(nextAdapterContext, netlifyAdapterContext)
    // TODO: verifyNetlifyForms
    await onBuildCompleteForHeaders(nextAdapterContext, netlifyAdapterContext)
    await onBuildCompleteForPagesAndAppHandlers(nextAdapterContext, netlifyAdapterContext)
    await onBuildCompleteForRouting(nextAdapterContext, netlifyAdapterContext)

    if (netlifyAdapterContext.frameworksAPIConfig) {
      // write out config if there is any
      await mkdir(dirname(NETLIFY_FRAMEWORKS_API_CONFIG_PATH), { recursive: true })
      await writeFile(
        NETLIFY_FRAMEWORKS_API_CONFIG_PATH,
        JSON.stringify(netlifyAdapterContext.frameworksAPIConfig, null, 2),
      )
    }
  },
}

export default adapter
