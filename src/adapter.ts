import type { NextAdapter } from 'next-with-adapters'

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config) {
    console.log('modifyConfig hook called')
    return config
  },
  async onBuildComplete(ctx) {
    console.log('onBuildComplete hook called')
  },
}

export default adapter
