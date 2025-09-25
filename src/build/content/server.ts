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
import { dirname, join, resolve, sep } from 'node:path'
import { join as posixJoin, sep as posixSep } from 'node:path/posix'

import { trace } from '@opentelemetry/api'
import { wrapTracer } from '@opentelemetry/api/experimental'
import glob from 'fast-glob'
import type { MiddlewareManifest } from 'next/dist/build/webpack/plugins/middleware-plugin.js'
import type { FunctionsConfigManifest } from 'next-with-cache-handler-v2/dist/build/index.js'
import { satisfies } from 'semver'

import type { RunConfig } from '../../run/config.js'
import { RUN_CONFIG_FILE } from '../../run/constants.js'
import type { PluginContext, RequiredServerFilesManifest } from '../plugin-context.js'

const tracer = wrapTracer(trace.getTracer('Next runtime'))

const toPosixPath = (path: string) => path.split(sep).join(posixSep)

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
        `server/edge/chunks/**/*`,
        `server/+(app|pages)/**/*.js`,
      ],
      {
        cwd: srcDir,
        dot: true,
        extglob: true,
      },
    )

    await Promise.all(
      paths.map(async (path: string) => {
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
      }),
    )
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

export const copyNextDependencies = async (ctx: PluginContext): Promise<void> => {
  await tracer.withActiveSpan('copyNextDependencies', async () => {
    const entries = await readdir(ctx.standaloneDir)
    const promises: Promise<void>[] = entries.map(async (entry) => {
      // copy all except the distDir (.next) folder as this is handled in a separate function
      // this will include the node_modules folder as well
      if (entry === ctx.nextDistDir) {
        return
      }
      const src = join(ctx.standaloneDir, entry)
      const dest = join(ctx.serverHandlerDir, entry)
      await cp(src, dest, { recursive: true, verbatimSymlinks: true, force: true })

      if (entry === 'node_modules') {
        await recreateNodeModuleSymlinks(ctx.resolveFromSiteDir('node_modules'), dest)
      }
    })

    // inside a monorepo there is a root `node_modules` folder that contains all the dependencies
    const rootSrcDir = join(ctx.standaloneRootDir, 'node_modules')
    const rootDestDir = join(ctx.serverHandlerRootDir, 'node_modules')

    // use the node_modules tree from the process.cwd() and not the one from the standalone output
    // as the standalone node_modules are already wrongly assembled by Next.js.
    // see: https://github.com/vercel/next.js/issues/50072
    if (existsSync(rootSrcDir) && ctx.standaloneRootDir !== ctx.standaloneDir) {
      promises.push(
        cp(rootSrcDir, rootDestDir, { recursive: true, verbatimSymlinks: true }).then(() =>
          recreateNodeModuleSymlinks(resolve('node_modules'), rootDestDir),
        ),
      )
    }

    await Promise.all(promises)

    const serverHandlerRequire = createRequire(posixJoin(ctx.serverHandlerDir, ':internal:'))

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
