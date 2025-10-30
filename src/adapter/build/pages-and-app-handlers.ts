import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path/posix'

import { glob } from 'fast-glob'

import {
  DISPLAY_NAME_PAGES_AND_APP,
  GENERATOR,
  NETLIFY_FRAMEWORKS_API_FUNCTIONS,
  PLUGIN_DIR,
} from './constants.js'
import type { NetlifyAdapterContext, OnBuildCompleteContext } from './types.js'

const PAGES_AND_APP_FUNCTION_INTERNAL_NAME = 'next_pages_and_app'

const RUNTIME_DIR = '.netlify'

const PAGES_AND_APP_FUNCTION_DIR = join(
  NETLIFY_FRAMEWORKS_API_FUNCTIONS,
  PAGES_AND_APP_FUNCTION_INTERNAL_NAME,
)

export async function onBuildComplete(
  nextAdapterContext: OnBuildCompleteContext,
  netlifyAdapterContext: NetlifyAdapterContext,
) {
  const requiredFiles = new Set<string>()
  const pathnameToEntry: Record<string, string> = {}

  for (const outputs of [
    nextAdapterContext.outputs.pages,
    nextAdapterContext.outputs.pagesApi,
    nextAdapterContext.outputs.appPages,
    nextAdapterContext.outputs.appRoutes,
  ]) {
    if (outputs) {
      for (const output of outputs) {
        if (output.runtime === 'edge') {
          // TODO: figure something out here
          continue
        }
        for (const asset of Object.values(output.assets)) {
          requiredFiles.add(asset)
        }

        requiredFiles.add(output.filePath)
        pathnameToEntry[output.pathname] = relative(nextAdapterContext.repoRoot, output.filePath)
      }
    }
  }

  await mkdir(PAGES_AND_APP_FUNCTION_DIR, { recursive: true })

  for (const filePath of requiredFiles) {
    await cp(
      filePath,
      join(PAGES_AND_APP_FUNCTION_DIR, relative(nextAdapterContext.repoRoot, filePath)),
      {
        recursive: true,
      },
    )
  }

  // copy needed runtime files

  await copyRuntime(join(PAGES_AND_APP_FUNCTION_DIR, RUNTIME_DIR))

  const functionsPaths = Object.keys(pathnameToEntry)

  // generate needed runtime files
  const entrypoint = /* javascript */ `
    import { AsyncLocalStorage } from 'node:async_hooks'
    import { createRequire } from 'node:module'
    import { runNextHandler } from './${RUNTIME_DIR}/dist/adapter/run/pages-and-app-handler.js'

    globalThis.AsyncLocalStorage = AsyncLocalStorage

    const require = createRequire(import.meta.url)

    const pathnameToEntry = ${JSON.stringify(pathnameToEntry, null, 2)}

    export default async function handler(request, context) {
      const url = new URL(request.url)

      const entry = pathnameToEntry[url.pathname]
      if (!entry) {
        return new Response('Not Found', { status: 404 })
      }

      const nextHandler = require('./' + entry).handler

      return runNextHandler(request, context, nextHandler)
    }

    export const config = {
      
      path: ${JSON.stringify(functionsPaths, null, 2)},
    }
  `
  await writeFile(
    join(PAGES_AND_APP_FUNCTION_DIR, `${PAGES_AND_APP_FUNCTION_INTERNAL_NAME}.mjs`),
    entrypoint,
  )

  // configuration
  netlifyAdapterContext.frameworksAPIConfig ??= {}
  netlifyAdapterContext.frameworksAPIConfig.functions ??= { '*': {} }
  netlifyAdapterContext.frameworksAPIConfig.functions[PAGES_AND_APP_FUNCTION_INTERNAL_NAME] = {
    node_bundler: 'none',
    included_files: ['**'],
    // TODO(pieh): below only works due to local patches, need to ship proper support
    included_files_base_path: PAGES_AND_APP_FUNCTION_DIR,
  }

  netlifyAdapterContext.preparedOutputs.endpoints.push(...functionsPaths)
}

const copyRuntime = async (handlerDirectory: string): Promise<void> => {
  const files = await glob('dist/**/*', {
    cwd: PLUGIN_DIR,
    ignore: ['**/*.test.ts'],
    dot: true,
  })
  await Promise.all(
    files.map((path) =>
      cp(join(PLUGIN_DIR, path), join(handlerDirectory, path), { recursive: true }),
    ),
  )
  // We need to create a package.json file with type: module to make sure that the runtime modules
  // are handled correctly as ESM modules
  await writeFile(join(handlerDirectory, 'package.json'), JSON.stringify({ type: 'module' }))
}
