import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { PluginContext } from './plugin-context.js'

interface FunctionsConfigManifest {
  version: number
  functions: Record<string, Record<string, string | number>>
}

// eslint-disable-next-line no-shadow
export const enum ApiRouteType {
  SCHEDULED = 'experimental-scheduled',
  BACKGROUND = 'experimental-background',
}

interface ApiStandardConfig {
  type?: never
  runtime?: 'nodejs' | 'experimental-edge' | 'edge'
  schedule?: never
}

interface ApiScheduledConfig {
  type: ApiRouteType.SCHEDULED
  runtime?: 'nodejs'
  schedule: string
}

interface ApiBackgroundConfig {
  type: ApiRouteType.BACKGROUND
  runtime?: 'nodejs'
  schedule?: never
}

type ApiConfig = ApiStandardConfig | ApiScheduledConfig | ApiBackgroundConfig

export async function getAPIRoutesConfigs(ctx: PluginContext) {
  const uniqueApiRoutes = new Set<string>()

  const functionsConfigManifestPath = join(
    ctx.publishDir,
    'server',
    'functions-config-manifest.json',
  )
  if (existsSync(functionsConfigManifestPath)) {
    // before https://github.com/vercel/next.js/pull/60163 this file might not have been produced if there were no API routes at all
    const functionsConfigManifest = JSON.parse(
      await readFile(functionsConfigManifestPath, 'utf-8'),
    ) as FunctionsConfigManifest

    for (const apiRoute of Object.keys(functionsConfigManifest.functions)) {
      uniqueApiRoutes.add(apiRoute)
    }
  }

  const pagesManifestPath = join(ctx.publishDir, 'server', 'pages-manifest.json')
  if (existsSync(pagesManifestPath)) {
    const pagesManifest = JSON.parse(await readFile(pagesManifestPath, 'utf-8'))
    for (const route of Object.keys(pagesManifest)) {
      if (route.startsWith('/api/')) {
        uniqueApiRoutes.add(route)
      }
    }
  }

  // no routes to analyze
  if (uniqueApiRoutes.size === 0) {
    return []
  }

  const appDir = ctx.resolveFromSiteDir('.')
  const pagesDir = join(appDir, 'pages')
  const srcPagesDir = join(appDir, 'src', 'pages')
  const { pageExtensions } = ctx.requiredServerFiles.config

  return Promise.all(
    [...uniqueApiRoutes].map(async (apiRoute) => {
      const filePath = getSourceFileForPage(apiRoute, [pagesDir, srcPagesDir], pageExtensions)

      const sharedFields = {
        apiRoute,
        filePath,
        config: {} as ApiConfig,
      }

      if (filePath) {
        const config = await extractConfigFromFile(filePath, appDir)
        return {
          ...sharedFields,
          config,
        }
      }

      return sharedFields
    }),
  )
}

// Next.js already defines a default `pageExtensions` array in its `required-server-files.json` file
// In case it gets `undefined`, this is a fallback
const SOURCE_FILE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx']

/**
 * Find the source file for a given page route
 */
const getSourceFileForPage = (
  page: string,
  roots: string[],
  pageExtensions = SOURCE_FILE_EXTENSIONS,
) => {
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
}

/**
 * Given an array of base paths and candidate modules, return the first one that exists
 */
const findModuleFromBase = ({
  paths,
  candidates,
}: {
  paths: string[]
  candidates: string[]
}): string | null => {
  for (const candidate of candidates) {
    try {
      const modulePath = require.resolve(candidate, { paths })
      if (modulePath) {
        return modulePath
      }
    } catch {
      // Ignore the error
    }
  }
  // if we couldn't find a module from paths, let's try to resolve from here
  for (const candidate of candidates) {
    try {
      const modulePath = require.resolve(candidate)
      if (modulePath) {
        return modulePath
      }
    } catch {
      // Ignore the error
    }
  }
  return null
}

let extractConstValue: typeof import('next/dist/build/analysis/extract-const-value.js')
let parseModule: typeof import('next/dist/build/analysis/parse-module.js').parseModule

const extractConfigFromFile = async (apiFilePath: string, appDir: string): Promise<ApiConfig> => {
  if (!apiFilePath || !existsSync(apiFilePath)) {
    return {}
  }

  const extractConstValueModulePath = findModuleFromBase({
    paths: [appDir],
    candidates: ['next/dist/build/analysis/extract-const-value'],
  })

  const parseModulePath = findModuleFromBase({
    paths: [appDir],
    candidates: ['next/dist/build/analysis/parse-module'],
  })

  if (!extractConstValueModulePath || !parseModulePath) {
    // Old Next.js version
    return {}
  }

  if (!extractConstValue && extractConstValueModulePath) {
    // eslint-disable-next-line import/no-dynamic-require, n/global-require
    extractConstValue = require(extractConstValueModulePath)
  }
  if (!parseModule && parseModulePath) {
    // eslint-disable-next-line prefer-destructuring, @typescript-eslint/no-var-requires, import/no-dynamic-require, n/global-require
    parseModule = require(parseModulePath).parseModule
  }

  const { extractExportedConstValue } = extractConstValue

  const fileContent = await readFile(apiFilePath, 'utf8')
  // No need to parse if there's no "config"
  if (!fileContent.includes('config')) {
    return {}
  }

  try {
    // https://github.com/vercel/next.js/pull/85787 introduced need to manually install SWC bindings
    // before usage. There are certain cases where Next.js will do that automatically, but to ensure
    // it works for all cases, we do install it here as well. If bindings are already installed, this is a no-op.
    const installBindingsModule = findModuleFromBase({
      paths: [appDir],
      candidates: ['next/dist/build/swc/install-bindings'],
    })
    if (installBindingsModule) {
      // eslint-disable-next-line import/no-dynamic-require, n/global-require, @typescript-eslint/no-var-requires
      const { installBindings } = require(installBindingsModule)
      await installBindings()
    }
  } catch {
    // nothing actionable can be done in case of exceptions
  }

  const ast = await parseModule(apiFilePath, fileContent)

  try {
    return extractExportedConstValue(ast, 'config') as ApiConfig
  } catch {
    return {}
  }
}
