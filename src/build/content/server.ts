import { existsSync } from 'node:fs'
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { join as posixJoin, relative as posixRelative, sep as posixSep } from 'node:path/posix'

import { trace } from '@opentelemetry/api'
import { wrapTracer } from '@opentelemetry/api/experimental'
import glob from 'fast-glob'
import type { MiddlewareManifest } from 'next/dist/build/webpack/plugins/middleware-plugin.js'
import type { FunctionsConfigManifest } from 'next-with-cache-handler-v2/dist/build/index.js'
import { prerelease, satisfies, lt as semverLowerThan, lte as semverLowerThanOrEqual } from 'semver'

import { ADAPTER_OUTPUT_FILE } from '../../adapter/adapter-output.js'
import type { SerializedAdapterOutput } from '../../adapter/adapter-output.js'
import type { RunConfig } from '../../run/config.js'
import { RUN_CONFIG_FILE } from '../../run/constants.js'
import type { PluginContext, RequiredServerFilesManifest } from '../plugin-context.js'

export const ADAPTER_MANIFEST_FILE = 'adapter-manifest.json'

const tracer = wrapTracer(trace.getTracer('Next runtime'))

const toPosixPath = (path: string) =>
  path
    .replace(/^\\+\?\\+/, '') // https://github.com/nodejs/node/blob/81e05e124f71b3050cd4e60c95017af975568413/lib/internal/fs/utils.js#L370-L372
    .split(sep)
    .join(posixSep)

function isError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

/**
 * Copy App/Pages Router Javascript needed by the server handler
 */
export const copyNextServerCode = async (ctx: PluginContext): Promise<void> => {
  await tracer.withActiveSpan('copyNextServerCode', async () => {
    // update the dist directory inside the required-server-files.json to work with
    // nx monorepos and other setups where the dist directory is modified
    const reqServerFilesPath = join(
      ctx.standaloneRootDir,
      ctx.relativeAppDir,
      ctx.requiredServerFiles.config.distDir,
      'required-server-files.json',
    )
    try {
      await access(reqServerFilesPath)
    } catch (error) {
      if (isError(error) && error.code === 'ENOENT') {
        // this error at this point is problem in runtime and not user configuration
        ctx.failBuild(
          `Failed creating server handler. required-server-files.json file not found at expected location "${reqServerFilesPath}". Your repository setup is currently not yet supported.`,
        )
      } else {
        throw error
      }
    }
    const reqServerFiles = JSON.parse(
      await readFile(reqServerFilesPath, 'utf-8'),
    ) as RequiredServerFilesManifest

    // if the resolved dist folder does not match the distDir of the required-server-files.json
    // this means the path got altered by a plugin like nx and contained ../../ parts so we have to reset it
    // to point to the correct lambda destination
    if (
      toPosixPath(ctx.distDir).replace(new RegExp(`^${ctx.relativeAppDir}/?`), '') !==
      reqServerFiles.config.distDir
    ) {
      // set the distDir to the latest path portion of the publish dir
      reqServerFiles.config.distDir = ctx.nextDistDir
      await writeFile(reqServerFilesPath, JSON.stringify(reqServerFiles))
    }

    // ensure the directory exists before writing to it
    await mkdir(ctx.serverHandlerDir, { recursive: true })
    // write our run-config.json to the root dir so that we can easily get the runtime config of the required-server-files.json
    // without the need to know about the monorepo or distDir configuration upfront.
    await writeFile(
      join(ctx.serverHandlerDir, RUN_CONFIG_FILE),
      JSON.stringify({
        nextConfig: reqServerFiles.config,
        nextVersion: ctx.nextVersion,
        // only enable setting up 'use cache' handler when Next.js supports CacheHandlerV2 as we don't have V1 compatible implementation
        // see https://github.com/vercel/next.js/pull/76687 first released in v15.3.0-canary.13
        enableUseCacheHandler: ctx.nextVersion
          ? satisfies(ctx.nextVersion, '>=15.3.0-canary.13', {
              includePrerelease: true,
            })
          : false,
      } satisfies RunConfig),
      'utf-8',
    )

    const srcDir = join(ctx.standaloneDir, ctx.nextDistDir)
    // if the distDir got resolved and altered use the nextDistDir instead
    const nextFolder =
      toPosixPath(ctx.distDir) === toPosixPath(ctx.buildConfig.distDir)
        ? ctx.distDir
        : ctx.nextDistDir
    const destDir = join(ctx.serverHandlerDir, nextFolder)

    const paths = await glob(
      [
        `*`,
        `server/*`,
        `server/chunks/**/*`,
        `server/edge-chunks/**/*`,
        `server/edge/**/*`,
        `server/+(app|pages)/**/*.js`,
      ],
      {
        cwd: srcDir,
        dot: true,
        extglob: true,
      },
    )

    const promises = paths.map(async (path: string) => {
      const srcPath = join(srcDir, path)
      const destPath = join(destDir, path)

      // If this is the middleware manifest file, replace it with an empty
      // manifest to avoid running middleware again in the server handler.
      if (path === 'server/middleware-manifest.json') {
        try {
          await replaceMiddlewareManifest(srcPath, destPath)
        } catch (error) {
          throw new Error('Could not patch middleware manifest file', { cause: error })
        }

        return
      }

      if (path === 'server/functions-config-manifest.json') {
        try {
          await replaceFunctionsConfigManifest(srcPath, destPath)
        } catch (error) {
          throw new Error('Could not patch functions config manifest file', { cause: error })
        }

        return
      }

      await cp(srcPath, destPath, { recursive: true, force: true })
    })

    // this is different node_modules than ones handled by `copyNextDependencies`
    // this is under the standalone/.next folder (not standalone/node_modules or standalone/<some-workspace/node_modules)
    // and started to be created by Next.js in some cases in next@16.1.0-canary.3
    // this node_modules is artificially created and doesn't have equivalent in the repo
    // so we only copy it, without additional symlinks handling
    if (existsSync(join(srcDir, 'node_modules'))) {
      const filter = ctx.constants.IS_LOCAL ? undefined : nodeModulesFilter
      const src = join(srcDir, 'node_modules')
      const dest = join(destDir, 'node_modules')
      await cp(src, dest, {
        recursive: true,
        verbatimSymlinks: true,
        force: true,
        filter,
      })
    }

    await Promise.all(promises)
  })
}

/**
 * Recreates the missing symlinks from the source node_modules inside the destination node_modules
 * @param src The source node_modules directory where the node_modules are located with the correct symlinks
 * @param dest The destination node_modules directory where the node_modules are located in where the symlinks are missing
 * @returns
 */
async function recreateNodeModuleSymlinks(src: string, dest: string, org?: string): Promise<void> {
  const dirents = await readdir(join(src, org || ''), { withFileTypes: true })

  await Promise.all(
    dirents.map(async (dirent) => {
      // in case of a node_module starting with an @ it is an organization scoped dependency and we have to go
      // one level deeper as those directories are symlinked
      if (dirent.name.startsWith('@')) {
        return recreateNodeModuleSymlinks(src, dest, dirent.name)
      }

      // if it is a symlink we have to recreate it in the destination node_modules if it is not existing.
      if (dirent.isSymbolicLink()) {
        const symlinkSrc = join(dest, org || '', dirent.name)
        // the location where the symlink points to
        const symlinkTarget = await readlink(join(src, org || '', dirent.name))
        const symlinkDest = join(dest, org || '', symlinkTarget)
        // only copy over symlinks that are traced through the nft bundle
        // and don't exist in the destination node_modules
        if (existsSync(symlinkDest) && !existsSync(symlinkSrc)) {
          if (org) {
            // if it is an organization folder let's create the folder first
            await mkdir(join(dest, org), { recursive: true })
          }
          await symlink(symlinkTarget, symlinkSrc)
        }
      }
    }),
  )
}

export type NextInternalModuleReplacement = {
  /**
   * Minimum Next.js version that this patch should be applied to
   */
  minVersion: string
  /**
   * If the reason to patch was not addressed in Next.js we mark this as ongoing
   * to continue to test latest versions to know wether we should bump `maxStableVersion`
   */
  ongoing: boolean
  /**
   * Module that should be replaced
   */
  nextModule: string
  /**
   * Location of replacement module (relative to `<runtime>/dist/build/content`)
   */
  shimModule: string
} & (
  | {
      ongoing: true
      /**
       * Maximum Next.js version that this patch should be applied to, note that for ongoing patches
       * we will continue to apply patch for prerelease versions also as canary versions are released
       * very frequently and trying to target canary versions is not practical. If user is using
       * canary next versions they should be aware of the risks
       */
      maxStableVersion: string
    }
  | {
      ongoing: false
      /**
       * Maximum Next.js version that this patch should be applied to. This should be last released
       * version of Next.js before version making the patch not needed anymore (can be canary version).
       */
      maxVersion: string
    }
)

const nextInternalModuleReplacements: NextInternalModuleReplacement[] = [
  {
    // standalone is loading expensive Telemetry module that is not actually used
    // so this replace that module with lightweight no-op shim that doesn't load additional modules
    // see https://github.com/vercel/next.js/pull/63574 that removed need for this shim
    ongoing: false,
    minVersion: '13.5.0-canary.0',
    // perf released in https://github.com/vercel/next.js/releases/tag/v14.2.0-canary.43
    maxVersion: '14.2.0-canary.42',
    nextModule: 'next/dist/telemetry/storage.js',
    shimModule: './next-shims/telemetry-storage.cjs',
  },
]

export function getPatchesToApply(
  nextVersion: string,
  patches: NextInternalModuleReplacement[] = nextInternalModuleReplacements,
) {
  return patches.filter((patch) => {
    // don't apply patches for next versions below minVersion
    if (semverLowerThan(nextVersion, patch.minVersion)) {
      return false
    }

    if (patch.ongoing) {
      // apply ongoing patches when used next version is prerelease or NETLIFY_NEXT_FORCE_APPLY_ONGOING_PATCHES env var is used
      if (prerelease(nextVersion) || process.env.NETLIFY_NEXT_FORCE_APPLY_ONGOING_PATCHES) {
        return true
      }

      // apply ongoing patches for stable next versions below or equal maxStableVersion
      return semverLowerThanOrEqual(nextVersion, patch.maxStableVersion)
    }

    // apply patches for next versions below or equal maxVersion
    return semverLowerThanOrEqual(nextVersion, patch.maxVersion)
  })
}

async function patchNextModules(
  ctx: PluginContext,
  nextVersion: string,
  serverHandlerRequireResolve: NodeRequire['resolve'],
): Promise<void> {
  // apply only those patches that target used Next version
  const moduleReplacementsToApply = getPatchesToApply(nextVersion)

  if (moduleReplacementsToApply.length !== 0) {
    await Promise.all(
      moduleReplacementsToApply.map(async ({ nextModule, shimModule }) => {
        try {
          const nextModulePath = serverHandlerRequireResolve(nextModule)
          const shimModulePath = posixJoin(ctx.pluginDir, 'dist', 'build', 'content', shimModule)

          await cp(shimModulePath, nextModulePath, { force: true })
        } catch {
          // this is perf optimization, so failing it shouldn't break the build
        }
      }),
    )
  }
}

export const copyNextDependencies = async (ctx: PluginContext): Promise<void> => {
  await tracer.withActiveSpan('copyNextDependencies', async () => {
    const promises: Promise<void>[] = []

    const nodeModulesLocations = new Set<{ source: string; destination: string }>()
    const commonFilter = ctx.constants.IS_LOCAL ? undefined : nodeModulesFilter

    const dotNextDir = toPosixPath(join(ctx.standaloneDir, ctx.nextDistDir))

    const standaloneRootDir = toPosixPath(ctx.standaloneRootDir)
    const outputFileTracingRoot = toPosixPath(ctx.outputFileTracingRoot)

    await cp(ctx.standaloneRootDir, ctx.serverHandlerRootDir, {
      recursive: true,
      verbatimSymlinks: true,
      force: true,
      filter: async (sourcePath: string, destination: string) => {
        const posixSourcePath = toPosixPath(sourcePath)
        if (posixSourcePath === dotNextDir) {
          // copy all except the distDir (.next) folder as this is handled in a separate function
          // this will include the node_modules folder as well
          return false
        }

        if (sourcePath.endsWith('node_modules')) {
          // keep track of node_modules as we might need to recreate symlinks
          // we are still copying them
          nodeModulesLocations.add({
            source: posixSourcePath,
            destination: toPosixPath(destination),
          })
        }

        // finally apply common filter if defined
        return commonFilter?.(sourcePath) ?? true
      },
    })

    for (const {
      source: nodeModulesLocationInStandalone,
      destination: locationInServerHandler,
    } of nodeModulesLocations) {
      const relativeToRoot = posixRelative(standaloneRootDir, nodeModulesLocationInStandalone)
      const locationInProject = posixJoin(outputFileTracingRoot, relativeToRoot)

      promises.push(recreateNodeModuleSymlinks(locationInProject, locationInServerHandler))
    }

    await Promise.all(promises)

    const serverHandlerRequire = createRequire(posixJoin(ctx.serverHandlerDir, ':internal:'))

    if (ctx.nextVersion) {
      await patchNextModules(ctx, ctx.nextVersion, serverHandlerRequire.resolve)
    }

    // detect if it might lead to a runtime issue and throw an error upfront on build time instead of silently failing during runtime
    try {
      const nextEntryAbsolutePath = serverHandlerRequire.resolve('next')
      const nextRequire = createRequire(nextEntryAbsolutePath)
      nextRequire.resolve('styled-jsx')
    } catch {
      throw new Error(
        'node_modules are not installed correctly, if you are using pnpm please set the public hoist pattern to: `public-hoist-pattern[]=*`.\n' +
          'Refer to your docs for more details: https://docs.netlify.com/integrations/frameworks/next-js/overview/#pnpm-support',
      )
    }
  })
}

/**
 * Generates a copy of the middleware manifest that make all matchers never match on anything. We
 * do this because we'll run middleware in an edge function, and we don't want
 * to run it again in the server handler. Additionally Next.js conditionally enable some handling
 * depending if there is a middleware present, so we need to keep reference to middleware in server
 * even if we don't actually want to ever run it there.
 */
const replaceMiddlewareManifest = async (sourcePath: string, destPath: string) => {
  await mkdir(dirname(destPath), { recursive: true })

  const data = await readFile(sourcePath, 'utf8')
  const manifest = JSON.parse(data) as MiddlewareManifest

  // TODO: Check for `manifest.version` and write an error to the system log
  // when we find a value that is not equal to 2. This will alert us in case
  // Next.js starts using a new format for the manifest and we're writing
  // one with the old version.
  const newManifest = {
    ...manifest,
    middleware: Object.fromEntries(
      Object.entries(manifest.middleware).map(([key, edgeFunctionDefinition]) => {
        return [
          key,
          {
            ...edgeFunctionDefinition,
            matchers: edgeFunctionDefinition.matchers.map((matcher) => {
              return {
                ...matcher,
                // matcher that won't match on anything
                // this is meant to disable actually running middleware in the server handler,
                // while still allowing next server to enable some middleware specific handling
                // such as _next/data normalization ( https://github.com/vercel/next.js/blob/7bb72e508572237fe0d4aac5418546d4b4b3a363/packages/next/src/server/lib/router-utils/resolve-routes.ts#L395 )
                regexp: '(?!.*)',
              }
            }),
          },
        ]
      }),
    ),
  }
  const newData = JSON.stringify(newManifest)

  await writeFile(destPath, newData)
}

// similar to the middleware manifest, we need to patch the functions config manifest to disable
// the middleware that is defined in the functions config manifest. This is needed to avoid running
// the middleware in the server handler, while still allowing next server to enable some middleware
// specific handling such as _next/data normalization ( https://github.com/vercel/next.js/blob/7bb72e508572237fe0d4aac5418546d4b4b3a363/packages/next/src/server/lib/router-utils/resolve-routes.ts#L395 )
const replaceFunctionsConfigManifest = async (sourcePath: string, destPath: string) => {
  const data = await readFile(sourcePath, 'utf8')
  const manifest = JSON.parse(data) as FunctionsConfigManifest

  // https://github.com/vercel/next.js/blob/8367faedd61501025299e92d43a28393c7bb50e2/packages/next/src/build/index.ts#L2465
  // Node.js Middleware has hardcoded /_middleware path
  if (manifest?.functions?.['/_middleware']?.matchers) {
    const newManifest = {
      ...manifest,
      functions: {
        ...manifest.functions,
        '/_middleware': {
          ...manifest.functions['/_middleware'],
          matchers: manifest.functions['/_middleware'].matchers.map((matcher) => {
            return {
              ...matcher,
              // matcher that won't match on anything
              // this is meant to disable actually running middleware in the server handler,
              // while still allowing next server to enable some middleware specific handling
              // such as _next/data normalization ( https://github.com/vercel/next.js/blob/7bb72e508572237fe0d4aac5418546d4b4b3a363/packages/next/src/server/lib/router-utils/resolve-routes.ts#L395 )
              regexp: '(?!.*)',
            }
          }),
        },
      },
    }
    const newData = JSON.stringify(newManifest)

    await writeFile(destPath, newData)
  } else {
    await cp(sourcePath, destPath, { recursive: true, force: true })
  }
}

/**
 * Copy Next.js server code using adapter-provided traced assets instead of standalone output.
 * Collects all assets from all function outputs and copies them preserving relative paths.
 */
export const copyNextServerCodeFromAdapter = async (ctx: PluginContext): Promise<void> => {
  await tracer.withActiveSpan('copyNextServerCodeFromAdapter', async () => {
    const adapterOutput = ctx.adapterOutput!

    await mkdir(ctx.serverHandlerDir, { recursive: true })

    // Write run-config.json
    // Cast config through unknown because next-with-adapters' NextConfigComplete
    // differs slightly from the `next` package's type, but they're compatible at runtime
    await writeFile(
      join(ctx.serverHandlerDir, RUN_CONFIG_FILE),
      JSON.stringify({
        nextConfig: adapterOutput.config as unknown as RunConfig['nextConfig'],
        nextVersion: adapterOutput.nextVersion,
        enableUseCacheHandler: satisfies(adapterOutput.nextVersion, '>=15.3.0-canary.13', {
          includePrerelease: true,
        }),
      } satisfies RunConfig),
      'utf-8',
    )

    // Write the adapter manifest (routing + output metadata) for runtime use.
    // filePaths are already relative (rewritten in the adapter's onBuildComplete).
    await writeFile(
      join(ctx.serverHandlerDir, ADAPTER_MANIFEST_FILE),
      JSON.stringify({
        routing: adapterOutput.routing,
        outputs: adapterOutput.outputs,
        buildId: adapterOutput.buildId,
        config: adapterOutput.config,
      }),
      'utf-8',
    )

    // Collect all assets from all function outputs into a unified map
    // key = relative path from repoRoot, value = absolute path on disk
    const allAssets = new Map<string, string>()
    const outputArrays = [
      adapterOutput.outputs.pages,
      adapterOutput.outputs.pagesApi,
      adapterOutput.outputs.appPages,
      adapterOutput.outputs.appRoutes,
    ] as const

    for (const outputs of outputArrays) {
      for (const output of outputs) {
        // filePath is already relative to repoRoot (rewritten in adapter's onBuildComplete).
        // Resolve the absolute source path for copying.
        allAssets.set(output.filePath, join(adapterOutput.repoRoot, output.filePath))

        // Add all traced assets
        for (const [relPath, absPath] of Object.entries(output.assets)) {
          allAssets.set(relPath, absPath)
        }
      }
    }

    // Copy all collected assets preserving relative paths
    const copyPromises: Promise<void>[] = []
    for (const [relPath, absPath] of allAssets) {
      const destPath = join(ctx.serverHandlerRootDir, relPath)
      copyPromises.push(
        mkdir(dirname(destPath), { recursive: true }).then(() =>
          cp(absPath, destPath, { recursive: true, force: true }),
        ),
      )
    }
    await Promise.all(copyPromises)
  })
}

export const verifyHandlerDirStructure = async (ctx: PluginContext) => {
  const { nextConfig } = JSON.parse(
    await readFile(join(ctx.serverHandlerDir, RUN_CONFIG_FILE), 'utf-8'),
  ) as RunConfig

  const expectedBuildIDPath = join(ctx.serverHandlerDir, nextConfig.distDir, 'BUILD_ID')
  if (!existsSync(expectedBuildIDPath)) {
    ctx.failBuild(
      `Failed creating server handler. BUILD_ID file not found at expected location "${expectedBuildIDPath}".`,
    )
  }
}

// This is a workaround for Next.js installations in a pnpm+glibc context
// Patch required due to an intermittent upstream issue in the npm/pnpm ecosystem
// https://github.com/pnpm/pnpm/issues/9654
// https://github.com/pnpm/pnpm/issues/5928
// https://github.com/pnpm/pnpm/issues/7362 (persisting even though ticket is closed)
const nodeModulesFilter = (sourcePath: string) => {
  // Filtering rule for the following packages:
  // - @rspack+binding-linux-x64-musl
  // - @swc+core-linux-x64-musl
  // - @img+sharp-linuxmusl-x64
  // - @img+sharp-libvips-linuxmusl-x64
  if (
    sourcePath.includes('.pnpm') &&
    (sourcePath.includes('linuxmusl-x64') || sourcePath.includes('linux-x64-musl'))
  ) {
    return false
  }

  return true
}
