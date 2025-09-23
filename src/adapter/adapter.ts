import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { NextAdapter } from 'next-with-adapters'

import {
  modifyConfig as modifyConfigForImageCDN,
  onBuildComplete as onBuildCompleteForImageCDN,
} from './image-cdn.js'

const NETLIFY_FRAMEWORKS_API_CONFIG_PATH = '.netlify/v1/config.json'

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config) {
    // Enable Next.js standalone mode at build time
    config.output = 'standalone'

    modifyConfigForImageCDN(config)

    return config
  },
  async onBuildComplete(ctx) {
    console.log('onBuildComplete hook called')

    // TODO: do we have a type for this? https://docs.netlify.com/build/frameworks/frameworks-api/#netlifyv1configjson
    let frameworksAPIConfig: any = null

    frameworksAPIConfig = onBuildCompleteForImageCDN(ctx, frameworksAPIConfig)

    if (frameworksAPIConfig) {
      // write out config if there is any
      await mkdir(dirname(NETLIFY_FRAMEWORKS_API_CONFIG_PATH), { recursive: true })
      await writeFile(
        NETLIFY_FRAMEWORKS_API_CONFIG_PATH,
        JSON.stringify(frameworksAPIConfig, null, 2),
      )
    }

    // for dev/debugging purposes only
    await writeFile('./onBuildComplete.json', JSON.stringify(ctx, null, 2))
    debugger
  },
}

export default adapter
