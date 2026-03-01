import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { NextAdapter } from 'next-with-adapters'
import { satisfies } from 'semver'

import { NETLIFY_IMAGE_LOADER_FILE } from '../build/image-cdn.js'

import { ADAPTER_OUTPUT_FILE } from './adapter-output.js'

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config, ctx) {
    // TODO(adapter) - to unset output here, we need to know for sure that adapter API version
    // is one that we support. Currently this hook doesn't declare version. So unsetting standalone
    // here is risky.
    if (ctx?.phase === 'phase-production-build' && config.output !== 'export') {
      // If not export, make sure to not build standalone output to avoid wasteful work
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
    // TODO(adapter): this is just a version I am using for now
    // if adapter API won't change - this can stay as-is, otherwise version will be bumped
    // to ensure we only support most recent Adapters API version while it's experimental to avoid
    // having to support multiple versions of the API at the same time.
    if (!satisfies(ctx.nextVersion, '>=16.2.0-canary.57')) {
      // if we don't save an adapter manifest and unset the standalone config,
      // we will continue to use standalone mode.

      // the config changes
      return
    }

    await writeFile(join(ctx.distDir, ADAPTER_OUTPUT_FILE), JSON.stringify(ctx), 'utf-8')

    // we can skip some any further work for standalone mode.
    // @ts-expect-error jsdocs say `undefined` is allowed, but typescript types not allow it.
    ctx.config.output = undefined
  },
}

export default adapter
