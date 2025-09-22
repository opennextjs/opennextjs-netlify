import type { NextAdapter } from 'next-with-adapters'

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config) {
    // Enable Next.js standalone mode at build time
    config.output = 'standalone'

    console.log('modifyConfig hook called')
    return config
  },
  async onBuildComplete(ctx) {
    console.log('onBuildComplete hook called')
  },
}

export default adapter
