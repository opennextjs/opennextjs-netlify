import { existsSync } from 'node:fs'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path/posix'

import { NEXT_RUNTIME_STATIC_ASSETS } from './constants.js'
import type { NetlifyAdapterContext, OnBuildCompleteContext } from './types.js'

export async function onBuildComplete(
  nextAdapterContext: OnBuildCompleteContext,
  netlifyAdapterContext: NetlifyAdapterContext,
) {
  for (const staticFile of nextAdapterContext.outputs.staticFiles) {
    try {
      let distPathname = staticFile.pathname
      if (extname(distPathname) === '' && extname(staticFile.filePath) === '.html') {
        // if it's fully static page, we need to also create empty _next/data JSON file
        // on Vercel this is done in routing layer, but we can't express that routing right now on Netlify
        const dataFilePath = join(
          NEXT_RUNTIME_STATIC_ASSETS,
          '_next',
          'data',
          nextAdapterContext.buildId,
          // eslint-disable-next-line unicorn/no-nested-ternary
          `${distPathname === '/' ? 'index' : distPathname.endsWith('/') ? distPathname.slice(0, -1) : distPathname}.json`,
        )
        await mkdir(dirname(dataFilePath), { recursive: true })
        await writeFile(dataFilePath, '{}')

        // FEEDBACK: should this be applied in Next.js before passing to context to adapters?
        if (distPathname !== '/') {
          if (nextAdapterContext.config.trailingSlash && !distPathname.endsWith('/')) {
            distPathname += '/'
          } else if (!nextAdapterContext.config.trailingSlash && distPathname.endsWith('/')) {
            distPathname = distPathname.slice(0, -1)
          }
        }

        // register static asset for routing before applying .html extension for pretty urls
        const extensionLessPathname = distPathname

        // if pathname is extension-less, but source file has an .html extension, preserve it
        distPathname += distPathname.endsWith('/') ? 'index.html' : '.html'

        netlifyAdapterContext.preparedOutputs.staticAssets.push(distPathname)
        netlifyAdapterContext.preparedOutputs.staticAssetsAliases[extensionLessPathname] =
          distPathname
      } else {
        // register static asset for routing
        netlifyAdapterContext.preparedOutputs.staticAssets.push(distPathname)
      }

      await cp(staticFile.filePath, join(NEXT_RUNTIME_STATIC_ASSETS, distPathname), {
        recursive: true,
      })
    } catch (error) {
      throw new Error(`Failed copying static asset.\n\n${JSON.stringify(staticFile, null, 2)}`, {
        cause: error,
      })
    }
  }

  // FEEDBACK: files in public directory are not in `outputs.staticFiles`
  if (existsSync('public')) {
    // copy all files from public directory to static assets
    await cp('public', NEXT_RUNTIME_STATIC_ASSETS, {
      recursive: true,
    })
    // TODO: glob things to add to preparedOutputs.staticAssets
  }

  const hasMiddleware = Boolean(nextAdapterContext.outputs.middleware)
  const hasPages =
    nextAdapterContext.outputs.pages.length !== 0 ||
    nextAdapterContext.outputs.pagesApi.length !== 0

  if (hasMiddleware && hasPages) {
    // create empty __next_data_catchall json file used for fully static pages
    await writeFile(join(NEXT_RUNTIME_STATIC_ASSETS, '__next_data_catchall.json'), '{}')
    netlifyAdapterContext.preparedOutputs.staticAssets.push('__next_data_catchall.json')
    netlifyAdapterContext.preparedOutputs.staticAssetsAliases.__next_data_catchall =
      '__next_data_catchall.json'
  }
}
