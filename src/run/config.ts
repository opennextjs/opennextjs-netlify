import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { NextConfigComplete } from 'next/dist/server/config-shared.js'

import type { SerializedAdapterOutput } from '../adapter/adapter-output.js'

import { ADAPTER_MANIFEST_FILE, PLUGIN_DIR, RUN_CONFIG_FILE } from './constants.js'
import { setInMemoryCacheMaxSizeFromNextConfig } from './storage/storage.cjs'

export type RunConfig = {
  nextConfig: NextConfigComplete
  nextVersion: string | null
  enableUseCacheHandler: boolean
}

/**
 * Subset of the adapter output that is needed at runtime for route resolution
 */
export type AdapterManifest = Pick<
  SerializedAdapterOutput,
  'routing' | 'outputs' | 'buildId' | 'config'
>

/**
 * Get Next.js config from the build output
 */
export const getRunConfig = async () => {
  return JSON.parse(await readFile(resolve(PLUGIN_DIR, RUN_CONFIG_FILE), 'utf-8')) as RunConfig
}

/**
 * Get the adapter manifest written at build time.
 * Uses the same PLUGIN_DIR resolution as getRunConfig() — both files are
 * written to ctx.serverHandlerDir during the build.
 */
export const getAdapterManifest = async (): Promise<AdapterManifest> => {
  return JSON.parse(
    await readFile(resolve(PLUGIN_DIR, ADAPTER_MANIFEST_FILE), 'utf-8'),
  ) as AdapterManifest
}

export type NextConfigForMultipleVersions = NextConfigComplete & {
  experimental: NextConfigComplete['experimental'] & {
    // those are pre 14.1.0 options that were moved out of experimental in // https://github.com/vercel/next.js/pull/57953/files#diff-c49c4767e6ed8627e6e1b8f96b141ee13246153f5e9142e1da03450c8e81e96fL311

    // https://github.com/vercel/next.js/blob/v14.0.4/packages/next/src/server/config-shared.ts#L182-L183
    // custom path to a cache handler to use
    incrementalCacheHandlerPath?: string
    // https://github.com/vercel/next.js/blob/v14.0.4/packages/next/src/server/config-shared.ts#L207-L212
    /**
     * In-memory cache size in bytes.
     *
     * If `isrMemoryCacheSize: 0` disables in-memory caching.
     */
    isrMemoryCacheSize?: number
  }
}

/**
 * Configure the custom cache handler at request time
 */
export const setRunConfig = (config: NextConfigForMultipleVersions) => {
  const cacheHandler = join(PLUGIN_DIR, '.netlify/dist/run/handlers/cache.cjs')
  if (!existsSync(cacheHandler)) {
    throw new Error(`Cache handler not found at ${cacheHandler}`)
  }

  // set the path to the cache handler
  config.experimental = {
    ...config.experimental,
    // Before Next.js 14.1.0 path to the cache handler was in experimental section, see NextConfigForMultipleVersions type
    incrementalCacheHandlerPath: cacheHandler,
  }

  // Next.js 14.1.0 moved the cache handler from experimental to stable, see NextConfigForMultipleVersions type
  config.cacheHandler = cacheHandler

  // honor the in-memory cache size from next.config (either one set by user or Next.js default)
  setInMemoryCacheMaxSizeFromNextConfig(
    config.cacheMaxMemorySize ?? config.experimental?.isrMemoryCacheSize,
  )

  // set config
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config)

  return config
}
