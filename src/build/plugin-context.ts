import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import { join as posixJoin, relative as posixRelative } from 'node:path/posix'
import { fileURLToPath } from 'node:url'

import type {
  NetlifyPluginConstants,
  NetlifyPluginOptions,
  NetlifyPluginUtils,
} from '@netlify/build'
import type { MiddlewareManifest } from 'next/dist/build/webpack/plugins/middleware-plugin.js'
import type { PagesManifest } from 'next/dist/build/webpack/plugins/pages-manifest-plugin.js'
import type { NextConfigComplete } from 'next/dist/server/config-shared.js'
import type {
  FunctionsConfigManifest,
  PrerenderManifest,
  RoutesManifest,
} from 'next-with-cache-handler-v2/dist/build/index.js'
import { satisfies } from 'semver'

import {
  ADAPTER_OUTPUT_FILE,
  type AdapterBuildCompleteContext,
  normalizeAndFixAdapterOutput,
} from '../adapter/adapter-output.js'

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN_DIR = join(MODULE_DIR, '../..')
const DEFAULT_PUBLISH_DIR = '.next'

export const SERVER_HANDLER_NAME = '___netlify-server-handler'
export const EDGE_HANDLER_NAME = '___netlify-edge-handler'

// copied from https://github.com/vercel/next.js/blob/af5b4db98ac1acccc3f167cc6aba2f0c9e7094df/packages/next/src/build/index.ts#L388-L395
// as this is not exported from the next.js package
export interface RequiredServerFilesManifest {
  version: number
  config: NextConfigComplete
  appDir: string
  relativeAppDir: string
  files: string[]
  ignore: string[]
}

export interface ExportDetail {
  success: boolean
  outDirectory: string
}

export class PluginContext {
  constants: NetlifyPluginConstants
  featureFlags: NetlifyPluginOptions['featureFlags']
  netlifyConfig: NetlifyPluginOptions['netlifyConfig']
  pluginName: string
  pluginVersion: string
  utils: NetlifyPluginUtils

  private packageJSON: { name: string; version: string } & Record<string, unknown>

  /** Absolute path of the next runtime plugin directory */
  pluginDir = PLUGIN_DIR

  get relPublishDir(): string {
    return (
      this.constants.PUBLISH_DIR ?? join(this.constants.PACKAGE_PATH || '', DEFAULT_PUBLISH_DIR)
    )
  }

  /** Temporary directory for stashing the build output */
  get tempPublishDir(): string {
    return this.resolveFromPackagePath('.netlify/.next')
  }

  /** Absolute path of the publish directory */
  get publishDir(): string {
    // Does not need to be resolved with the package path as it is always a repository absolute path
    // hence including already the `PACKAGE_PATH` therefore we don't use the `this.resolveFromPackagePath`
    return resolve(this.relPublishDir)
  }

  /**
   * Relative package path in non monorepo setups this is an empty string
   * This path is provided by Next.js RequiredServerFiles manifest
   * @example ''
   * @example 'apps/my-app'
   */
  get relativeAppDir(): string {
    return this.requiredServerFiles.relativeAppDir ?? ''
  }

  /**
   * The root directory for output file tracing. Paths inside standalone directory preserve paths of project, relative to this directory.
   */
  get outputFileTracingRoot(): string {
    if (this.hasAdapter()) {
      throw new Error('outputFileTracingRoot is not available in adapter mode')
    }
    // Up until https://github.com/vercel/next.js/pull/86812 we had direct access to computed value of it with following
    const outputFileTracingRootFromRequiredServerFiles =
      this.requiredServerFiles.config.outputFileTracingRoot ??
      // fallback for older Next.js versions that don't have outputFileTracingRoot in the config, but had it in config.experimental
      this.requiredServerFiles.config.experimental.outputFileTracingRoot
    if (outputFileTracingRootFromRequiredServerFiles) {
      return outputFileTracingRootFromRequiredServerFiles
    }

    if (!this.relativeAppDir.includes('..')) {
      // For newer Next.js versions outputFileTracingRoot is not written to the output directly anymore, but we can use appDir and relativeAppDir to compute it.
      // This assumes that relative app dir will never contain '..' segments. Some monorepos support workspaces outside of the monorepo root (verified with pnpm)
      // However Next.js itself have some limits on it:
      //  - turbopack by default would throw "Module not found: Can't resolve '<name_of_package_outside_of_root>'"
      //    forcing user to manually set `outputFileTracingRoot` in next.config which will impact `appDir` and `relativeAppDir` preserving the lack of '..' in `relativeAppDir`
      //  - webpack case depends on wether dependency is marked as external or not:
      //    - if it's marked as external then standalone while working locally, it would never work when someone tries to deploy it (and not just on Netlify, but also in fully self-hosted scenarios)
      //      because parts of application would be outside of "standalone" directory
      //    - if it's not marked as external it will be included in next.js produced chunks

      const depth = this.relativeAppDir === '' ? 0 : this.relativeAppDir.split(sep).length

      const computedOutputFileTracingRoot = resolve(
        this.requiredServerFiles.appDir,
        ...Array.from<string>({ length: depth }).fill('..'),
      )
      return computedOutputFileTracingRoot
    }

    // if relativeAppDir contains '..', we can't actually figure out the outputFileTracingRoot
    // so best fallback is to just cwd() which won't work in wild edge cases, but there is no way of getting anything better
    // if it's not correct it will cause build failures later when assembling a server handler function
    return process.cwd()
  }

  /**
   * The working directory inside the lambda that is used for monorepos to execute the serverless function
   */
  get lambdaWorkingDirectory(): string {
    return join('/var/task', this.distDirParent)
  }

  /**
   * Retrieves the root of the `.next/standalone` directory
   */
  get standaloneRootDir(): string {
    if (this.hasAdapter()) {
      throw new Error('standaloneRootDir is not available in adapter mode')
    }
    return join(this.publishDir, 'standalone')
  }

  /**
   * The resolved relative next dist directory defaults to `.next`,
   * but can be configured through the next.config.js. For monorepos this will include the packagePath
   * If we need just the plain dist dir use the `nextDistDir`
   */
  get distDir(): string {
    const dir = this.buildConfig.distDir ?? DEFAULT_PUBLISH_DIR
    // resolve the distDir relative to the process working directory in case it contains '../../'
    return relative(process.cwd(), resolve(this.relativeAppDir, dir))
  }

  /** Represents the parent directory of the .next folder or custom distDir */
  get distDirParent(): string {
    // the .. is omitting the last part of the dist dir like `.next` but as it can be any custom folder
    // let's just move one directory up with that
    return join(this.distDir, '..')
  }

  /** The `.next` folder or what the custom dist dir is set to */
  get nextDistDir(): string {
    return relative(this.distDirParent, this.distDir)
  }

  /** Retrieves the `.next/standalone/` directory monorepo aware */
  get standaloneDir(): string {
    if (this.hasAdapter()) {
      throw new Error('standaloneDir is not available in adapter mode')
    }
    // the standalone directory mimics the structure of the publish directory
    // that said if the publish directory is `apps/my-app/.next` the standalone directory will be `.next/standalone/apps/my-app`
    // if the publish directory is .next the standalone directory will be `.next/standalone`
    // for nx workspaces where the publish directory is on the root of the repository
    // like `dist/apps/my-app/.next` the standalone directory will be `.next/standalone/dist/apps/my-app`
    return join(this.standaloneRootDir, this.distDirParent)
  }

  /**
   * Absolute path of the directory that is published and deployed to the Netlify CDN
   * Will be swapped with the publish directory
   * `.netlify/static`
   */
  get staticDir(): string {
    return this.resolveFromPackagePath('.netlify/static')
  }

  /**
   * Absolute path of the directory that will be deployed to the blob store
   * region aware: `.netlify/deploy/v1/blobs/deploy`
   * default: `.netlify/blobs/deploy`
   */
  get blobDir(): string {
    if (this.useRegionalBlobs) {
      return this.resolveFromPackagePath('.netlify/deploy/v1/blobs/deploy')
    }

    return this.resolveFromPackagePath('.netlify/blobs/deploy')
  }

  get buildVersion(): string {
    return this.constants.NETLIFY_BUILD_VERSION || 'v0.0.0'
  }

  get useRegionalBlobs(): boolean {
    // Region-aware blobs are only available as of CLI v17.23.5 (i.e. Build v29.41.5)
    const REQUIRED_BUILD_VERSION = '>=29.41.5'
    return satisfies(this.buildVersion, REQUIRED_BUILD_VERSION, { includePrerelease: true })
  }

  /**
   * Absolute path of the directory containing the files for the serverless lambda function
   * `.netlify/functions-internal`
   */
  get serverFunctionsDir(): string {
    return this.resolveFromPackagePath('.netlify/functions-internal')
  }

  /** Absolute path of the server handler */
  get serverHandlerRootDir(): string {
    return join(this.serverFunctionsDir, SERVER_HANDLER_NAME)
  }

  get serverHandlerDir(): string {
    if (this.relativeAppDir.length === 0 || this.hasAdapter()) {
      return this.serverHandlerRootDir
    }
    return join(this.serverHandlerRootDir, this.distDirParent)
  }

  get serverHandlerRuntimeModulesDir(): string {
    if (this.hasAdapter()) {
      return join(this.serverHandlerRootDir, '.netlify')
    }

    return join(this.serverHandlerDir, '.netlify')
  }

  get nextServerHandler(): string {
    if (this.relativeAppDir.length !== 0) {
      return join(this.lambdaWorkingDirectory, '.netlify/dist/run/handlers/server.js')
    }
    return './.netlify/dist/run/handlers/server.js'
  }

  /**
   * Absolute path of the directory containing the files for deno edge functions
   * `.netlify/edge-functions`
   */
  get edgeFunctionsDir(): string {
    return this.resolveFromPackagePath('.netlify/edge-functions')
  }

  /** Absolute path of the edge handler */
  get edgeHandlerDir(): string {
    return join(this.edgeFunctionsDir, EDGE_HANDLER_NAME)
  }

  /** Absolute path to the skew protection config */
  get skewProtectionConfigPath(): string {
    return this.resolveFromPackagePath('.netlify/v1/skew-protection.json')
  }

  constructor(options: NetlifyPluginOptions) {
    this.constants = options.constants
    this.featureFlags = options.featureFlags
    this.netlifyConfig = options.netlifyConfig
    this.packageJSON = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf-8'))
    this.pluginName = this.packageJSON.name
    this.pluginVersion = this.packageJSON.version
    this.utils = options.utils
  }

  #adapterOutput: AdapterBuildCompleteContext | null | undefined = undefined

  /** Read and cache the adapter output JSON from publishDir if it exists */
  get adapterOutput(): AdapterBuildCompleteContext | null {
    if (typeof this.#adapterOutput === 'undefined') {
      const adapterOutputPath = join(this.publishDir, ADAPTER_OUTPUT_FILE)
      if (existsSync(adapterOutputPath)) {
        const originalAdapterOutput = JSON.parse(
          readFileSync(adapterOutputPath, 'utf-8'),
        ) as AdapterBuildCompleteContext
        this.#adapterOutput = normalizeAndFixAdapterOutput(originalAdapterOutput)
      } else {
        this.#adapterOutput = null
      }
    }
    return this.#adapterOutput
  }

  /** Whether the adapter API was used during the Next.js build */
  // eslint-disable-next-line no-use-before-define
  hasAdapter(): this is PluginContextAdapter {
    return this.adapterOutput !== null
  }

  /** Resolves a path correctly with mono repository awareness for .netlify directories mainly  */
  resolveFromPackagePath(...args: string[]): string {
    return resolve(this.constants.PACKAGE_PATH || '', ...args)
  }

  /** Resolves a path correctly from site directory */
  resolveFromSiteDir(...args: string[]): string {
    return resolve(this.requiredServerFiles.appDir, ...args)
  }

  /** Get the next prerender-manifest.json */
  async getPrerenderManifest(): Promise<PrerenderManifest> {
    return JSON.parse(await readFile(join(this.publishDir, 'prerender-manifest.json'), 'utf-8'))
  }

  /**
   * Uses various heuristics to try to find the .next dir.
   * Works by looking for BUILD_ID, so requires the site to have been built
   */
  findDotNext(): string | false {
    for (const dir of [
      // The publish directory
      this.publishDir,
      // In the root
      resolve(DEFAULT_PUBLISH_DIR),
      // The sibling of the publish directory
      resolve(this.publishDir, '..', DEFAULT_PUBLISH_DIR),
      // In the package dir
      resolve(this.constants.PACKAGE_PATH || '', DEFAULT_PUBLISH_DIR),
    ]) {
      if (existsSync(join(dir, 'BUILD_ID'))) {
        return dir
      }
    }
    return false
  }

  /**
   * Get Next.js middleware config from the build output
   */
  async getMiddlewareManifest(): Promise<MiddlewareManifest> {
    return JSON.parse(
      await readFile(join(this.publishDir, 'server/middleware-manifest.json'), 'utf-8'),
    )
  }

  /**
   * Get Next.js Functions Config Manifest config if it exists from the build output
   */
  async getFunctionsConfigManifest(): Promise<FunctionsConfigManifest | null> {
    const functionsConfigManifestPath = join(
      this.publishDir,
      'server/functions-config-manifest.json',
    )

    if (existsSync(functionsConfigManifestPath)) {
      return JSON.parse(await readFile(functionsConfigManifestPath, 'utf-8'))
    }

    // this file might not have been produced
    return null
  }

  // don't make private as it is handy inside testing to override the config
  _requiredServerFiles: RequiredServerFilesManifest | null = null

  /** Get RequiredServerFiles manifest from build output **/
  get requiredServerFiles(): RequiredServerFilesManifest {
    if (!this._requiredServerFiles) {
      if (this.hasAdapter()) {
        const adapter = this.adapterOutput
        this._requiredServerFiles = {
          version: 1,
          // The adapter's NextConfigComplete comes from next-with-adapters which is a different
          // version than the `next` package. The shapes are compatible at runtime (both are
          // serialized JSON), so we cast through unknown to bridge the type mismatch.
          config: adapter.config as unknown as NextConfigComplete,
          appDir: adapter.projectDir,
          relativeAppDir: relative(adapter.repoRoot, adapter.projectDir) || '',
          files: [],
          ignore: [],
        }
      } else {
        let requiredServerFilesJson = join(this.publishDir, 'required-server-files.json')

        if (!existsSync(requiredServerFilesJson)) {
          const dotNext = this.findDotNext()
          if (dotNext) {
            requiredServerFilesJson = join(dotNext, 'required-server-files.json')
          }
        }

        this._requiredServerFiles = JSON.parse(
          readFileSync(requiredServerFilesJson, 'utf-8'),
        ) as RequiredServerFilesManifest
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this._requiredServerFiles!
  }

  #exportDetail: ExportDetail | null = null

  /** Get metadata when output = export */
  get exportDetail(): ExportDetail | null {
    if (this.buildConfig.output !== 'export') {
      return null
    }
    if (!this.#exportDetail) {
      const detailFile = join(
        this.requiredServerFiles.appDir,
        this.buildConfig.distDir,
        'export-detail.json',
      )
      if (!existsSync(detailFile)) {
        return null
      }
      try {
        this.#exportDetail = JSON.parse(readFileSync(detailFile, 'utf-8'))
      } catch {}
    }
    return this.#exportDetail
  }

  /** Get Next Config from build output **/
  get buildConfig(): NextConfigComplete {
    return this.requiredServerFiles.config
  }

  /**
   * Get Next.js routes manifest from the build output
   */
  async getRoutesManifest(): Promise<RoutesManifest> {
    return JSON.parse(await readFile(join(this.publishDir, 'routes-manifest.json'), 'utf-8'))
  }

  #nextVersion: string | null | undefined = undefined

  /**
   * Get Next.js version that was used to build the site
   */
  get nextVersion(): string | null {
    if (this.#nextVersion === undefined) {
      if (this.hasAdapter()) {
        this.#nextVersion = this.adapterOutput.nextVersion
      } else {
        try {
          const serverHandlerRequire = createRequire(
            posixJoin(this.standaloneRootDir, ':internal:'),
          )
          const { version } = serverHandlerRequire('next/package.json')
          this.#nextVersion = version as string
        } catch {
          this.#nextVersion = null
        }
      }
    }

    return this.#nextVersion
  }

  #fallbacks: string[] | null = null
  /**
   * Get an array of localized fallback routes for Pages Router
   *
   * Example return value for non-i18n site: `['blog/[slug]']`
   *
   * Example return value for i18n site: `['en/blog/[slug]', 'fr/blog/[slug]']`
   */
  getFallbacks(prerenderManifest: PrerenderManifest): string[] {
    if (!this.#fallbacks) {
      // dynamic routes don't have entries for each locale so we have to generate them
      // ourselves. If i18n is not used we use empty string as "locale" to be able to use
      // same handling wether i18n is used or not
      const locales = this.buildConfig.i18n?.locales ?? ['']

      this.#fallbacks = Object.entries(prerenderManifest.dynamicRoutes).reduce(
        (fallbacks, [route, meta]) => {
          // fallback can be `string | false | null`
          //  - `string` - when user use pages router with `fallback: true`, and then it's html file path
          //  - `null` - when user use pages router with `fallback: 'block'` or app router with `export const dynamicParams = true`
          //  - `false` - when user use pages router with `fallback: false` or app router with `export const dynamicParams = false`
          if (typeof meta.fallback === 'string' && meta.renderingMode !== 'PARTIALLY_STATIC') {
            for (const locale of locales) {
              const localizedRoute = posixJoin(locale, route.replace(/^\/+/g, ''))
              fallbacks.push(localizedRoute)
            }
          }
          return fallbacks
        },
        [] as string[],
      )
    }

    return this.#fallbacks
  }

  #fullyStaticHtmlPages: string[] | null = null
  /**
   * Get an array of fully static pages router pages (no `getServerSideProps` or `getStaticProps`).
   * Those are being served as-is without involving CacheHandler, so we need to keep track of them
   * to make sure we apply permanent caching headers for responses that use them.
   */
  async getFullyStaticHtmlPages(): Promise<string[]> {
    if (!this.#fullyStaticHtmlPages) {
      const pagesManifest = JSON.parse(
        await readFile(join(this.publishDir, 'server/pages-manifest.json'), 'utf-8'),
      ) as PagesManifest

      this.#fullyStaticHtmlPages = Object.values(pagesManifest)
        .filter(
          (filePath) =>
            // Limit handling to pages router files (App Router pages should not be included in pages-manifest.json
            // as they have their own app-paths-manifest.json)
            filePath.startsWith('pages/') &&
            // Fully static pages will have entries in the pages-manifest.json pointing to .html files.
            // Pages with data fetching exports will point to .js files.
            filePath.endsWith('.html'),
        )
        // values will be prefixed with `pages/`, so removing it here for consistency with other methods
        // like `getFallbacks` that return the route without the prefix
        .map((filePath) => posixRelative('pages', filePath))
    }
    return this.#fullyStaticHtmlPages
  }

  #shells: string[] | null = null
  /**
   * Get an array of static shells for App Router's PPR dynamic routes
   */
  getShells(prerenderManifest: PrerenderManifest): string[] {
    if (!this.#shells) {
      this.#shells = Object.entries(prerenderManifest.dynamicRoutes).reduce(
        (shells, [route, meta]) => {
          if (typeof meta.fallback === 'string' && meta.renderingMode === 'PARTIALLY_STATIC') {
            shells.push(route)
          }
          return shells
        },
        [] as string[],
      )
    }

    return this.#shells
  }

  /** Fails a build with a message and an optional error */
  failBuild(message: string, error?: unknown): never {
    return this.utils.build.failBuild(message, error instanceof Error ? { error } : undefined)
  }
}

export type PluginContextAdapter = PluginContext & { adapterOutput: AdapterBuildCompleteContext }
