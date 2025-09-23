import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { trace } from '@opentelemetry/api'
import { wrapTracer } from '@opentelemetry/api/experimental'
import glob from 'fast-glob'

import type { HtmlBlob } from '../../shared/blob-types.cjs'
import { encodeBlobKey } from '../../shared/blobkey.js'
import { PluginContext } from '../plugin-context.js'
import { verifyNetlifyForms } from '../verification.js'

const tracer = wrapTracer(trace.getTracer('Next runtime'))

/**
 * Assemble the static content for being uploaded to the blob storage
 */
export const copyStaticContent = async (ctx: PluginContext): Promise<void> => {
  return tracer.withActiveSpan('copyStaticContent', async () => {
    const srcDir = join(ctx.publishDir, 'server/pages')
    const destDir = ctx.blobDir

    const paths = await glob('**/*.+(html|json)', {
      cwd: srcDir,
      extglob: true,
    })

    const fallbacks = ctx.getFallbacks(await ctx.getPrerenderManifest())
    const fullyStaticPages = await ctx.getFullyStaticHtmlPages()

    try {
      await mkdir(destDir, { recursive: true })
      await Promise.all(
        paths
          .filter((path) => !path.endsWith('.json') && !paths.includes(`${path.slice(0, -5)}.json`))
          .map(async (path): Promise<void> => {
            const html = await readFile(join(srcDir, path), 'utf-8')
            verifyNetlifyForms(ctx, html)

            const isFallback = fallbacks.includes(path.slice(0, -5))
            const isFullyStaticPage = !isFallback && fullyStaticPages.includes(path)

            await writeFile(
              join(destDir, await encodeBlobKey(path)),
              JSON.stringify({ html, isFullyStaticPage } satisfies HtmlBlob),
              'utf-8',
            )
          }),
      )
    } catch (error) {
      ctx.failBuild('Failed assembling static pages for upload', error)
    }
  })
}

export const copyStaticExport = async (ctx: PluginContext): Promise<void> => {
  await tracer.withActiveSpan('copyStaticExport', async () => {
    if (!ctx.exportDetail?.outDirectory) {
      ctx.failBuild('Export directory not found')
    }
    try {
      await rm(ctx.staticDir, { recursive: true, force: true })
      await cp(ctx.exportDetail.outDirectory, ctx.staticDir, { recursive: true })
    } catch (error) {
      ctx.failBuild('Failed copying static export', error)
    }
  })
}

/**
 * Swap the static dir with the publish dir so it is uploaded to the CDN
 */
export const publishStaticDir = async (ctx: PluginContext): Promise<void> => {
  try {
    await rm(ctx.tempPublishDir, { recursive: true, force: true })
    await mkdir(basename(ctx.tempPublishDir), { recursive: true })
    await rename(ctx.publishDir, ctx.tempPublishDir)
    await rename(ctx.staticDir, ctx.publishDir)
  } catch (error) {
    ctx.failBuild('Failed publishing static content', error instanceof Error ? { error } : {})
  }
}

/**
 * Restore the publish dir that was swapped with the static dir
 */
export const unpublishStaticDir = async (ctx: PluginContext): Promise<void> => {
  try {
    if (existsSync(ctx.tempPublishDir)) {
      await rename(ctx.publishDir, ctx.staticDir)
      await rename(ctx.tempPublishDir, ctx.publishDir)
    }
  } catch {
    // ignore
  }
}
