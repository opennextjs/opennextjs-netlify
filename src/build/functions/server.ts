import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { join as posixJoin } from 'node:path/posix'

import { trace } from '@opentelemetry/api'
import { wrapTracer } from '@opentelemetry/api/experimental'
import { glob } from 'fast-glob'

import {
  copyNextDependencies,
  copyNextServerCode,
  verifyHandlerDirStructure,
} from '../content/server.js'
import { PluginContext, SERVER_HANDLER_NAME } from '../plugin-context.js'

const tracer = wrapTracer(trace.getTracer('Next runtime'))

/** Copies the runtime dist folder to the lambda */
const copyHandlerDependencies = async (ctx: PluginContext) => {
  await tracer.withActiveSpan('copyHandlerDependencies', async (span) => {
    const promises: Promise<void>[] = []
    // if the user specified some files to include in the lambda
    // we need to copy them to the functions-internal folder
    const { included_files: includedFiles = [] } = ctx.netlifyConfig.functions?.['*'] || {}

    // we also force including the .env files to ensure those are available in the lambda
    includedFiles.push(
      posixJoin(ctx.relativeAppDir, '.env'),
      posixJoin(ctx.relativeAppDir, '.env.production'),
      posixJoin(ctx.relativeAppDir, '.env.local'),
      posixJoin(ctx.relativeAppDir, '.env.production.local'),
    )

    span.setAttribute('next.includedFiles', includedFiles.join(','))

    const resolvedFiles = await Promise.all(
      includedFiles.map((globPattern) => glob(globPattern, { cwd: process.cwd() })),
    )
    for (const filePath of resolvedFiles.flat()) {
      promises.push(
        cp(
          join(process.cwd(), filePath),
          // the serverHandlerDir is aware of the dist dir.
          // The distDir must not be the package path therefore we need to rely on the
          // serverHandlerDir instead of the serverHandlerRootDir
          // therefore we need to remove the package path from the filePath
          join(ctx.serverHandlerDir, relative(ctx.relativeAppDir, filePath)),
          {
            recursive: true,
            force: true,
          },
        ),
      )
    }

    // We need to create a package.json file with type: module to make sure that the runtime modules
    // are handled correctly as ESM modules
    promises.push(
      writeFile(
        join(ctx.serverHandlerRuntimeModulesDir, 'package.json'),
        JSON.stringify({ type: 'module' }),
      ),
    )

    const fileList = await glob('dist/**/*', { cwd: ctx.pluginDir })

    for (const filePath of fileList) {
      promises.push(
        cp(join(ctx.pluginDir, filePath), join(ctx.serverHandlerRuntimeModulesDir, filePath), {
          recursive: true,
          force: true,
        }),
      )
    }
    await Promise.all(promises)
  })
}

const writeHandlerManifest = async (ctx: PluginContext) => {
  await writeFile(
    join(ctx.serverHandlerRootDir, `${SERVER_HANDLER_NAME}.json`),
    JSON.stringify({
      config: {
        name: 'Next.js Server Handler',
        generator: `${ctx.pluginName}@${ctx.pluginVersion}`,
        nodeBundler: 'none',
        // the folders can vary in monorepos based on the folder structure of the user so we have to glob all
        includedFiles: ['**'],
        includedFilesBasePath: ctx.serverHandlerRootDir,
      },
      version: 1,
    }),
    'utf-8',
  )
}

const applyTemplateVariables = (template: string, variables: Record<string, string>) => {
  return Object.entries(variables).reduce((acc, [key, value]) => {
    return acc.replaceAll(key, value)
  }, template)
}

/** Convert Next.js route syntax to URLPattern syntax */
const transformRoutePatterns = (route: string): string => {
  return route
    .replace(/\[\[\.\.\.(\w+)]]/g, ':$1*') // [[...slug]] -> :slug*
    .replace(/\[\.{3}(\w+)]/g, ':$1+') // [...slug] -> :slug+
    .replace(/\[(\w+)]/g, ':$1') // [id] -> :id
}

const getRoutes = async (ctx: PluginContext) => {
  const internalRoutes = [
    '/_next/static/*',
    '/_next/data/*',
    '/_next/image/*',
    '/_next/postponed/*',
  ]

  const routesManifest = await ctx.getRoutesManifest()
  const staticRoutes = routesManifest.staticRoutes.map((route) => route.page)
  const dynamicRoutes = routesManifest.dynamicRoutes.map((route) => route.page)

  // route.source conforms to the URLPattern syntax, which will work with our redirect engine
  // however this will be a superset of possible routes as it does not parse the
  // header/cookie/query matching that Next.js offers
  const redirects = routesManifest.redirects.map((route) => route.source)
  const rewrites = Array.isArray(routesManifest.rewrites)
    ? routesManifest.rewrites.map((route) => route.source)
    : []

  // this contains the static Route Handler routes
  const appPathRoutesManifest = await ctx.getAppPathRoutesManifest()
  const appRoutes = Object.values(appPathRoutesManifest)

  // this contains the API handler routes
  const pagesManifest = await ctx.getPagesManifest()
  const pagesRoutes = Object.keys(pagesManifest)

  return [
    ...internalRoutes,
    ...staticRoutes,
    ...dynamicRoutes,
    ...redirects,
    ...rewrites,
    ...appRoutes,
    ...pagesRoutes,
    '/*', // retain the catch-all route for our initial testing
  ].map(transformRoutePatterns)
}

/** Get's the content of the handler file that will be written to the lambda */
const getHandlerFile = async (ctx: PluginContext): Promise<string> => {
  const routes = await getRoutes(ctx)

  const templatesDir = join(ctx.pluginDir, 'dist/build/templates')
  const templateVariables: Record<string, string> = {
    '{{useRegionalBlobs}}': ctx.useRegionalBlobs.toString(),
    '{{paths}}': routes.join("','"),
  }
  // In this case it is a monorepo and we need to use a own template for it
  // as we have to change the process working directory
  if (ctx.relativeAppDir.length !== 0) {
    const template = await readFile(join(templatesDir, 'handler-monorepo.tmpl.js'), 'utf-8')

    templateVariables['{{cwd}}'] = posixJoin(ctx.lambdaWorkingDirectory)
    templateVariables['{{nextServerHandler}}'] = posixJoin(ctx.nextServerHandler)

    return applyTemplateVariables(template, templateVariables)
  }

  return applyTemplateVariables(
    await readFile(join(templatesDir, 'handler.tmpl.js'), 'utf-8'),
    templateVariables,
  )
}

const writeHandlerFile = async (ctx: PluginContext) => {
  const handler = await getHandlerFile(ctx)
  await writeFile(join(ctx.serverHandlerRootDir, `${SERVER_HANDLER_NAME}.mjs`), handler)
}

export const clearStaleServerHandlers = async (ctx: PluginContext) => {
  await rm(ctx.serverFunctionsDir, { recursive: true, force: true })
}

/**
 * Create a Netlify function to run the Next.js server
 */
export const createServerHandler = async (ctx: PluginContext) => {
  await tracer.withActiveSpan('createServerHandler', async () => {
    await mkdir(join(ctx.serverHandlerRuntimeModulesDir), { recursive: true })

    await copyNextServerCode(ctx)
    await copyNextDependencies(ctx)
    await copyHandlerDependencies(ctx)
    await writeHandlerManifest(ctx)
    await writeHandlerFile(ctx)

    await verifyHandlerDirStructure(ctx)
  })
}
