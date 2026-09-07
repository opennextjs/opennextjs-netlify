import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

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

/**
 * Copy static content to the static dir so it is uploaded to the CDN
 */
export const copyStaticAssets = async (ctx: PluginContext): Promise<void> => {
  return tracer.withActiveSpan('copyStaticAssets', async (span): Promise<void> => {
    try {
      await rm(ctx.staticDir, { recursive: true, force: true })
      const { basePath } = await ctx.getRoutesManifest()
      if (existsSync(ctx.resolveFromSiteDir('public'))) {
        await cp(ctx.resolveFromSiteDir('public'), join(ctx.staticDir, basePath), {
          recursive: true,
        })
      }
      const { adapterOutput, relativeAppDir, staticDir, netlifyConfig, publishDir } = ctx
      if (adapterOutput) {
        // the adapter output lists `<distDir>/static` and the static metadata routes (robots.txt,
        // sitemap.xml, manifest.webmanifest, static opengraph-image...) that Next writes to
        // `server/app/<route>.body`; `public/` is not in it (copied above). Static HTML pages stay
        // on blobs: the function handles their 404 status and durable caching.
        const { repoRoot, config, outputs } = adapterOutput
        const distDir = join(relativeAppDir, config.distDir)
        const cdnServedPrefixes = [`${distDir}/static/`, `${distDir}/server/app/`]
        await Promise.all(
          outputs.staticFiles.map(async (output) => {
            // filePaths are repoRoot-relative once fixAdapterOutputForNextRouting ran, absolute before
            const filePath = isAbsolute(output.filePath)
              ? relative(repoRoot, output.filePath)
              : output.filePath
            if (!cdnServedPrefixes.some((prefix) => filePath.startsWith(prefix))) {
              return
            }
            const src = join(repoRoot, filePath)
            const dest = join(staticDir, output.pathname)
            await mkdir(dirname(dest), { recursive: true })
            await cp(src, dest)
            if (!filePath.endsWith('.body')) {
              return
            }
            // the CDN guesses the content-type from the extension, which is wrong for e.g.
            // `.webmanifest`; Next's `.meta` sidecar has the one the route handler set
            const meta = JSON.parse(
              await readFile(`${src.slice(0, -'.body'.length)}.meta`, 'utf-8'),
            ) as {
              headers?: Record<string, string>
            }
            const contentType = meta.headers?.['content-type']
            if (contentType) {
              netlifyConfig.headers.push({
                for: output.pathname,
                values: { 'Content-Type': contentType },
              })
            }
          }),
        )
      } else if (existsSync(join(publishDir, 'static'))) {
        await cp(join(publishDir, 'static'), join(staticDir, basePath, '_next/static'), {
          recursive: true,
        })
      }
    } catch (error) {
      span.end()
      ctx.failBuild('Failed copying static assets', error)
    }
  })
}

export const setHeadersConfig = async (ctx: PluginContext): Promise<void> => {
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/headers#cache-control
  // Next.js sets the Cache-Control header of public, max-age=31536000, immutable for truly
  // immutable assets. It cannot be overridden. These immutable files contain a SHA-hash in
  // the file name, so they can be safely cached indefinitely.
  const { basePath } = ctx.buildConfig
  ctx.netlifyConfig.headers.push({
    for: `${basePath}/_next/static/*`,
    values: {
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })

  // Next.js only serves `Service-Worker-Allowed` for `_next/static/service-worker/*` when that
  // directory exists and is non-empty. Netlify serves these files directly from the CDN, so we
  // replicate the check against the filesystem instead of `routes-manifest.json`, which isn't
  // generated for static exports. This is safe because `copyStaticAssets` only reads from
  // `ctx.publishDir`, so there's no concurrent write to race with.
  const serviceWorkerDir = join(ctx.publishDir, 'static', 'service-worker')
  let hasServiceWorker = existsSync(serviceWorkerDir)
  if (hasServiceWorker) {
    const serviceWorkerFiles = await readdir(serviceWorkerDir)
    hasServiceWorker = serviceWorkerFiles.length !== 0
  }

  if (hasServiceWorker) {
    ctx.netlifyConfig.headers.push({
      // tested when deployed, this ordering of Netlify headers works fine
      // for same header names, the more specific "for" wins
      // for different header names, the values get merged
      for: `${basePath}/_next/static/service-worker/*`,
      values: {
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Service-Worker-Allowed': basePath || '/',
      },
    })
  }
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
