import type { NextAdapter } from 'next-with-adapters'

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config) {
    // Enable Next.js standalone mode at build time
    config.output = 'standalone'

    if (config.images.loader === 'default') {
      // Set up Netlify Image CDN image's loaderFile
      config.images.loader = 'custom'
      config.images.loaderFile = '@netlify/plugin-nextjs/dist/next-image-loader.cjs'
    }

    return config
  },
  async onBuildComplete(ctx) {
    console.log('onBuildComplete hook called')
  },
}

export default adapter
