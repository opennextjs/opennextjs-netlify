import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path/posix'

import type { HtmlBlob } from '../shared/blob-types.cjs'
import { encodeBlobKey } from '../shared/blobkey.js'

import type { FrameworksAPIConfig, OnBuildCompleteContext } from './types.js'

export async function onBuildComplete(
  ctx: OnBuildCompleteContext,
  frameworksAPIConfigArg: FrameworksAPIConfig,
) {
  const frameworksAPIConfig: FrameworksAPIConfig = frameworksAPIConfigArg ?? {}

  const BLOBS_DIRECTORY = join(ctx.projectDir, '.netlify/deploy/v1/blobs/deploy')

  try {
    await mkdir(BLOBS_DIRECTORY, { recursive: true })

    for (const appPage of ctx.outputs.appPages) {
      const html = await readFile(appPage.filePath, 'utf-8')

      await writeFile(
        join(BLOBS_DIRECTORY, await encodeBlobKey(appPage.pathname)),
        JSON.stringify({ html, isFullyStaticPage: false } satisfies HtmlBlob),
        'utf-8',
      )
    }

    for (const appRoute of ctx.outputs.appRoutes) {
      const html = await readFile(appRoute.filePath, 'utf-8')

      await writeFile(
        join(BLOBS_DIRECTORY, await encodeBlobKey(appRoute.pathname)),
        JSON.stringify({ html, isFullyStaticPage: false } satisfies HtmlBlob),
        'utf-8',
      )
    }
  } catch (error) {
    throw new Error(`Failed assembling static pages for upload`, { cause: error })
  }

  return frameworksAPIConfig
}
