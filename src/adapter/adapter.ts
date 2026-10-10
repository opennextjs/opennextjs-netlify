import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { NextAdapter } from 'next-with-adapters'
import { satisfies } from 'semver'

import { ADAPTER_OUTPUT_FILE } from './adapter-output.js'

// TODO(adapter): this is just a version I am using for now
// if adapter API won't change - this can stay as-is, otherwise version will be bumped
// to ensure we only support most recent Adapters API version while it's experimental to avoid
// having to support multiple versions of the API at the same time.
const MIN_NEXT_VERSION = '16.3.0'

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config, ctx) {
    if (
      ctx?.phase === 'phase-production-build' &&
      config.output !== 'export' &&
      satisfies(ctx.nextVersion, `>=${MIN_NEXT_VERSION}`, { includePrerelease: true })
    ) {
      // If not export, make sure to not build standalone output to avoid wasteful work
      // @ts-expect-error - types don't allow unsetting output, even if `undefined` is actually a default
      config.output = undefined
      // the image optimizer's disk cache can't live in a function, see setRunConfig
      config.images = {
        ...config.images,
        maximumDiskCacheSize: 0,
      }
    }

    return config
  },
  async onBuildComplete(ctx) {
    if (!satisfies(ctx.nextVersion, `>=${MIN_NEXT_VERSION}`, { includePrerelease: true })) {
      // if we don't save an adapter manifest and unset the standalone config,
      // we will continue to use standalone mode.
      return
    }

    await writeFile(join(ctx.distDir, ADAPTER_OUTPUT_FILE), JSON.stringify(ctx), 'utf-8')
  },
}

export default adapter
