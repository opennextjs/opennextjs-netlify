import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { basename } from 'node:path'

import { trace } from '@opentelemetry/api'
import { wrapTracer } from '@opentelemetry/api/experimental'

import { PluginContext } from '../plugin-context.js'

const tracer = wrapTracer(trace.getTracer('Next runtime'))

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
