import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { NextAdapter } from 'next-with-adapters'

import { onBuildComplete as onBuildCompleteForHeaders } from './header.js'
import {
  modifyConfig as modifyConfigForImageCDN,
  onBuildComplete as onBuildCompleteForImageCDN,
} from './image-cdn.js'
import { onBuildComplete as onBuildCompleteForMiddleware } from './middleware.js'
import { onBuildComplete as onBuildCompleteForStaticFiles } from './static.js'
import { FrameworksAPIConfig } from './types.js'

const NETLIFY_FRAMEWORKS_API_CONFIG_PATH = '.netlify/v1/config.json'

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

    let frameworksAPIConfig: FrameworksAPIConfig = null

    frameworksAPIConfig = onBuildCompleteForImageCDN(nextAdapterContext, frameworksAPIConfig)
    frameworksAPIConfig = await onBuildCompleteForMiddleware(
      nextAdapterContext,
      frameworksAPIConfig,
    )
    frameworksAPIConfig = await onBuildCompleteForStaticFiles(
      nextAdapterContext,
      frameworksAPIConfig,
    )
    frameworksAPIConfig = onBuildCompleteForHeaders(nextAdapterContext, frameworksAPIConfig)

    if (frameworksAPIConfig) {
      // write out config if there is any
      await mkdir(dirname(NETLIFY_FRAMEWORKS_API_CONFIG_PATH), { recursive: true })
      await writeFile(
        NETLIFY_FRAMEWORKS_API_CONFIG_PATH,
        JSON.stringify(frameworksAPIConfig, null, 2),
      )
    }
  },
}

export default adapter
