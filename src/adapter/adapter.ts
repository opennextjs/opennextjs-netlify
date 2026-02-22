import type { NextAdapter } from 'next-with-adapters'

import { NETLIFY_IMAGE_LOADER_FILE } from '../build/image-cdn.js'

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config, ctx) {
    if (ctx?.phase === 'phase-production-build' && config.output !== 'export') {
      // If not export, make sure to not build standalone output as it will become useless
      // // @ts-expect-error types don't unsetting output to not use 'standalone'
      // config.output = undefined
    }

    if (config.images.loader === 'default') {
      // Set up Netlify Image CDN image's loaderFile
      // see https://nextjs.org/docs/app/api-reference/config/next-config-js/images
      config.images.loader = 'custom'
      config.images.loaderFile = NETLIFY_IMAGE_LOADER_FILE
    }

    return config
  },
  async onBuildComplete(ctx) {
    // no-op
  },
}

export default adapter
