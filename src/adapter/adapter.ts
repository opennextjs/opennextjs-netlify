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
import { onBuildComplete as onBuildCompleteForStaticAssets } from './build/static-assets.js'

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config) {
    if (config.output !== 'export') {
      // Enable Next.js standalone mode at build time
      config.output = 'standalone'
    }

    modifyConfigForImageCDN(config)

    return config
  },
  async onBuildComplete(nextAdapterContext) {
    // for dev/debugging purposes only
    await writeFile('./onBuildComplete.json', JSON.stringify(nextAdapterContext, null, 2))
    // debugger

    console.log('onBuildComplete hook called')

    const netlifyAdapterContext = createNetlifyAdapterContext(nextAdapterContext)

    await onBuildCompleteForImageCDN(nextAdapterContext, netlifyAdapterContext)
    await onBuildCompleteForMiddleware(nextAdapterContext, netlifyAdapterContext)
    await onBuildCompleteForStaticAssets(nextAdapterContext, netlifyAdapterContext)
    // TODO: verifyNetlifyForms
    await onBuildCompleteForHeaders(nextAdapterContext, netlifyAdapterContext)
    await onBuildCompleteForPagesAndAppHandlers(nextAdapterContext, netlifyAdapterContext)

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
