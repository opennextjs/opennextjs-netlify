import { writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { NextAdapter } from 'next-with-adapters'
import { satisfies } from 'semver'

import { NETLIFY_IMAGE_LOADER_FILE } from '../build/image-cdn.js'

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
    if (!satisfies(ctx.nextVersion, `>=${MIN_NEXT_VERSION}`, { includePrerelease: true })) {
      // if we don't save an adapter manifest and unset the standalone config,
      // we will continue to use standalone mode.
      return
    }

    await writeFile(
      join(ctx.distDir, ADAPTER_OUTPUT_FILE),
      JSON.stringify({
        ...ctx,
        // same expression Next.js bakes into route modules as __NEXT_RELATIVE_PROJECT_DIR
        // (build/define-env), which they use as the RouterServerContext key at runtime
        relativeProjectDir: relative(process.cwd(), ctx.projectDir),
      }),
      'utf-8',
    )
  },
}

export default adapter
