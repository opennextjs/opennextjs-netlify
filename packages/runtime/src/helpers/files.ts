import { cpus } from 'os'

import type { Blobs } from '@netlify/blobs'
import type { NetlifyConfig } from '@netlify/build'
import { yellowBright } from 'chalk'
import { existsSync, readJson, move, copy, writeJson, ensureDir, readFileSync, remove, readFile } from 'fs-extra'
import globby from 'globby'
import { PrerenderManifest } from 'next/dist/build'
import { outdent } from 'outdent'
import pLimit from 'p-limit'
import { join, resolve, dirname } from 'pathe'
import slash from 'slash'

import { MINIMUM_REVALIDATE_SECONDS, DIVIDER, HIDDEN_PATHS } from '../constants'
import { getNormalizedBlobKey } from '../templates/blobStorage'

import { NextConfig } from './config'
import { loadPrerenderManifest } from './edge'
import { Rewrites, RoutesManifest } from './types'
import { findModuleFromBase } from './utils'

const TEST_ROUTE = /(|\/)\[[^/]+?](\/|\.html|$)/

export const isDynamicRoute = (route) => TEST_ROUTE.test(route)

export const stripLocale = (rawPath: string, locales: Array<string> = []) => {
  const [locale, ...segments] = rawPath.split('/')
  if (locales.includes(locale)) {
    return segments.join('/')
  }
  return rawPath
}

export const matchMiddleware = (middleware: Array<string>, filePath: string): string | boolean =>
  middleware?.includes('') ||
  middleware?.find(
    (middlewarePath) =>
      filePath === middlewarePath || filePath === `${middlewarePath}.html` || filePath.startsWith(`${middlewarePath}/`),
  )

export const matchesRedirect = (file: string, redirects: Rewrites): boolean => {
  if (!Array.isArray(redirects)) {
    return false
  }
  return redirects.some((redirect) => {
    if (!redirect.regex || redirect.internal) {
      return false
    }
    // Strips the extension from the file path
    return new RegExp(redirect.regex).test(`/${file.slice(0, -5)}`)
  })
}

export const matchesRewrite = (file: string, rewrites: Rewrites): boolean => {
  if (Array.isArray(rewrites)) {
    return matchesRedirect(file, rewrites)
  }
  if (!Array.isArray(rewrites?.beforeFiles)) {
    return false
  }
  return matchesRedirect(file, rewrites.beforeFiles)
}

export const getMiddleware = async (publish: string): Promise<Array<string>> => {
  if (process.env.NEXT_DISABLE_NETLIFY_EDGE !== 'true' && process.env.NEXT_DISABLE_NETLIFY_EDGE !== '1') {
    return []
  }
  const manifestPath = join(publish, 'server', 'middleware-manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = await readJson(manifestPath, { throws: false })
    return manifest?.sortedMiddleware ?? []
  }
  return []
}

// eslint-disable-next-line max-lines-per-function
export const moveStaticPages = async ({
  netlifyConfig,
  target,
  nextConfig,
  netliBlob,
}: {
  netlifyConfig: NetlifyConfig
  target: 'server' | 'serverless' | 'experimental-serverless-trace'
  nextConfig: Pick<NextConfig, 'i18n' | 'basePath'>
  netliBlob?: Blobs
}): Promise<void> => {
  const { i18n, basePath } = nextConfig
  console.log('Moving static page files to serve from CDN...')
  const outputDir = join(netlifyConfig.build.publish, target === 'serverless' ? 'serverless' : 'server')
  const buildId = readFileSync(join(netlifyConfig.build.publish, 'BUILD_ID'), 'utf8').trim()
  const dataDir = join('_next', 'data', buildId)
  await ensureDir(join(netlifyConfig.build.publish, dataDir))
  // Load the middleware manifest so we can check if a file matches it before moving
  const middlewarePaths = await getMiddleware(netlifyConfig.build.publish)
  const middleware = middlewarePaths.map((path) => path.slice(1))

  const prerenderManifest: PrerenderManifest = await loadPrerenderManifest(netlifyConfig)
  const { redirects, rewrites }: RoutesManifest = await readJson(
    join(netlifyConfig.build.publish, 'routes-manifest.json'),
  )

  const isrFiles = new Set<string>()

  const shortRevalidateRoutes: Array<{ Route: string; Revalidate: number }> = []

  Object.entries(prerenderManifest.routes).forEach(([route, ssgRoute]) => {
    const { initialRevalidateSeconds } = ssgRoute
    const trimmedPath = route === '/' ? 'index' : route.slice(1)

    if (initialRevalidateSeconds) {
      // Find all files used by ISR routes
      isrFiles.add(`${trimmedPath}.html`)
      isrFiles.add(`${trimmedPath}.json`)
      isrFiles.add(`${trimmedPath}.rsc`)
      if (initialRevalidateSeconds < MINIMUM_REVALIDATE_SECONDS) {
        shortRevalidateRoutes.push({ Route: route, Revalidate: initialRevalidateSeconds })
      }
    }
  })

  let fileCount = 0
  let blobCount = 0
  const filesManifest: Record<string, string> = {}
  const blobsManifest = new Set<string>()

  const getSourceAndTargetPath = (file: string): { targetPath: string; source: string } => {
    const source = join(outputDir, file)
    // Strip the initial 'app' or 'pages' directory from the output path
    const pathname = file.split('/').slice(1).join('/')
    // .rsc data files go next to the html file
    const isData = file.endsWith('.json')
    const targetFile = isData ? join(dataDir, pathname) : pathname
    const targetPath = basePath ? join(basePath, targetFile) : targetFile

    return {
      targetPath,
      source,
    }
  }

  const moveFile = async (file: string) => {
    const { source, targetPath } = getSourceAndTargetPath(file)

    fileCount += 1
    filesManifest[file] = targetPath

    const dest = join(netlifyConfig.build.publish, targetPath)

    try {
      await move(source, dest)
    } catch (error) {
      console.warn('Error moving file', source, error)
    }
  }
  const uploadFileToBlobStorageAndDelete = async (file: string) => {
    const { source } = getSourceAndTargetPath(file)

    blobsManifest.add(file)

    const content = await readFile(source, 'utf8')

    blobCount += 1

    await netliBlob.set(getNormalizedBlobKey(file), content)
    await remove(source)
  }
  // Move all static files, except nft manifests
  const pages = await globby(['{app,pages}/**/*.{html,json,rsc}', '!**/*.js.nft.{html,json}'], {
    cwd: outputDir,
    dot: true,
  })

  const matchingMiddleware = new Set()
  const matchedPages = new Set()
  const matchedRedirects = new Set()
  const matchedRewrites = new Set()

  // Limit concurrent file moves to number of cpus or 2 if there is only 1
  const limit = pLimit(Math.max(2, cpus().length))
  const promises = pages.map((rawPath) => {
    // Convert to POSIX path
    const filePath = slash(rawPath)
    // Remove the initial 'app' or 'pages' directory from the output path
    const pagePath = filePath.split('/').slice(1).join('/')

    if (isrFiles.has(pagePath)) {
      if (netliBlob) {
        // if netliblob is enabled, we will move ISR assets to blob store and delete files after that
        // to minimize the number of files needed in lambda
        return limit(uploadFileToBlobStorageAndDelete, filePath)
      }
      // Don't move ISR files, as they're used for the first request
      return
    }
    if (isDynamicRoute(pagePath)) {
      return
    }
    if (matchesRedirect(pagePath, redirects)) {
      matchedRedirects.add(pagePath)
      return
    }
    if (matchesRewrite(pagePath, rewrites)) {
      matchedRewrites.add(pagePath)
      return
    }
    // Middleware matches against the unlocalised path
    const unlocalizedPath = stripLocale(pagePath, i18n?.locales)
    const middlewarePath = matchMiddleware(middleware, unlocalizedPath)
    // If a file matches middleware it can't be offloaded to the CDN, and needs to stay at the origin to be served by next/server
    if (middlewarePath) {
      matchingMiddleware.add(middlewarePath)
      matchedPages.add(filePath)
      return
    }
    return limit(moveFile, filePath)
  })
  await Promise.all(promises)
  console.log(`Moved ${fileCount} files to CDN`)
  if (netliBlob) {
    console.log(`Moved ${blobCount} files to Blob Storage`)
  }

  if (matchedPages.size !== 0) {
    console.log(
      yellowBright(outdent`
        Skipped moving ${matchedPages.size} ${
          matchedPages.size === 1 ? 'file because it matches' : 'files because they match'
        } middleware, so cannot be deployed to the CDN and will be served from the origin instead.
        This is fine, but we're letting you know because it may not be what you expect.
      `),
    )

    console.log(
      outdent`
        The following middleware matched statically-rendered pages:

        ${yellowBright([...matchingMiddleware].map((mid) => `- /${mid}/_middleware`).join('\n'))}
        ${DIVIDER}
      `,
    )
    // There could potentially be thousands of matching pages, so we don't want to spam the console with this
    if (matchedPages.size < 50) {
      console.log(
        outdent`
          The following files matched middleware and were not moved to the CDN:

          ${yellowBright([...matchedPages].map((mid) => `- ${mid}`).join('\n'))}
          ${DIVIDER}
        `,
      )
    }
  }

  if (matchedRedirects.size !== 0 || matchedRewrites.size !== 0) {
    console.log(
      yellowBright(outdent`
        Skipped moving ${
          matchedRedirects.size + matchedRewrites.size
        } files because they match redirects or beforeFiles rewrites, so cannot be deployed to the CDN and will be served from the origin instead.
      `),
    )
    if (matchedRedirects.size < 50 && matchedRedirects.size !== 0) {
      console.log(
        outdent`
          The following files matched redirects and were not moved to the CDN:

          ${yellowBright([...matchedRedirects].map((mid) => `- ${mid}`).join('\n'))}
          ${DIVIDER}
        `,
      )
    }
    if (matchedRewrites.size < 50 && matchedRewrites.size !== 0) {
      console.log(
        outdent`
          The following files matched beforeFiles rewrites and were not moved to the CDN:

          ${yellowBright([...matchedRewrites].map((mid) => `- ${mid}`).join('\n'))}
          ${DIVIDER}
        `,
      )
    }
  }

  // Write the manifests for use in the serverless functions
  await writeJson(join(netlifyConfig.build.publish, 'static-manifest.json'), Object.entries(filesManifest))
  await writeJson(join(netlifyConfig.build.publish, 'blobs-manifest.json'), [...blobsManifest])

  if (i18n?.defaultLocale) {
    const rootPath = basePath ? join(netlifyConfig.build.publish, basePath) : netlifyConfig.build.publish
    // Copy the default locale into the root
    const defaultLocaleDir = join(rootPath, i18n.defaultLocale)
    if (existsSync(defaultLocaleDir)) {
      await copy(defaultLocaleDir, `${rootPath}/`)
    }
    const defaultLocaleIndex = join(rootPath, `${i18n.defaultLocale}.html`)
    const indexHtml = join(rootPath, 'index.html')
    if (existsSync(defaultLocaleIndex) && !existsSync(indexHtml)) {
      await copy(defaultLocaleIndex, indexHtml, { overwrite: false }).catch(() => {
        /* ignore */
      })
      await copy(join(rootPath, `${i18n.defaultLocale}.json`), join(rootPath, 'index.json'), {
        overwrite: false,
      }).catch(() => {
        /* ignore */
      })
    }
  }

  if (shortRevalidateRoutes.length !== 0) {
    console.log(outdent`
      The following routes use "revalidate" values of under ${MINIMUM_REVALIDATE_SECONDS} seconds, which is not supported.
      They will use a revalidate time of ${MINIMUM_REVALIDATE_SECONDS} seconds instead.
    `)
    console.table(shortRevalidateRoutes)
    // TODO: add these docs
    // console.log(
    //   outdent`
    //     For more information, see https://ntl.fyi/next-revalidate-time
    //     ${DIVIDER}
    //   `,
    // )
  }
}

/**
 * The file we need has moved around a bit over the past few versions,
 * so we iterate through the options until we find it
 */
export const getServerFile = (root: string, includeBase = true) => {
  const candidates = ['next/dist/server/next-server', 'next/dist/next-server/server/next-server']

  if (includeBase) {
    candidates.unshift('next/dist/server/base-server')
  }

  return findModuleFromBase({ candidates, paths: [root] })
}

// Next.js already defines a default `pageExtensions` array in its `required-server-files.json` file
// In case it gets `undefined`, this is a fallback
const SOURCE_FILE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx']

/**
 * Find the source file for a given page route
 */
export const getSourceFileForPage = (page: string, roots: string[], pageExtensions = SOURCE_FILE_EXTENSIONS) => {
  for (const root of roots) {
    for (const extension of pageExtensions) {
      const file = join(root, `${page}.${extension}`)
      if (existsSync(file)) {
        return file
      }

      const fileAtFolderIndex = join(root, page, `index.${extension}`)
      if (existsSync(fileAtFolderIndex)) {
        return fileAtFolderIndex
      }
    }
  }
  console.log('Could not find source file for page', page)
}

/**
 * Reads the node file trace file for a given file, and resolves the dependencies
 */
export const getDependenciesOfFile = async (file: string) => {
  const nft = `${file}.nft.json`
  if (!existsSync(nft)) {
    return []
  }
  const dependencies = (await readJson(nft, 'utf8')) as { files: string[] }
  return dependencies.files.map((dep) => resolve(dirname(file), dep))
}

export const movePublicFiles = async ({
  appDir,
  outdir,
  publish,
  basePath,
}: {
  appDir: string
  outdir?: string
  publish: string
  basePath: string
}): Promise<void> => {
  // `outdir` is a config property added when using Next.js with Nx. It's typically
  // a relative path outside of the appDir, e.g. '../../dist/apps/<app-name>', and
  // the parent directory of the .next directory.
  // If it exists, copy the files from the public folder there in order to include
  // any files that were generated during the build. Otherwise, copy the public
  // directory from the original app directory.
  const publicDir = outdir ? join(appDir, outdir, 'public') : join(appDir, 'public')
  if (existsSync(publicDir)) {
    await copy(publicDir, `${publish}${basePath}/`)
  }
}

export const removeMetadataFiles = async (publish: string) => {
  // Limit concurrent deletions to number of cpus or 2 if there is only 1
  const limit = pLimit(Math.max(2, cpus().length))

  const removePromises = HIDDEN_PATHS.map((HIDDEN_PATH) => {
    const pathToDelete = join(publish, HIDDEN_PATH)
    return limit(() => remove(pathToDelete))
  })

  await Promise.all(removePromises)
}
