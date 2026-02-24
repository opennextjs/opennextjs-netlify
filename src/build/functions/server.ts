import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { join as posixJoin } from 'node:path/posix'

import { trace } from '@opentelemetry/api'
import { wrapTracer } from '@opentelemetry/api/experimental'
import { glob } from 'fast-glob'

import { copyNextServerCodeFromAdapter } from '../content/server-adapter.js'
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
        name: ctx.useAdapter ? 'Next.js Adapter Server Handler' : 'Next.js Server Handler',
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

/** Get's the content of the handler file that will be written to the lambda */
const getHandlerFile = async (ctx: PluginContext): Promise<string> => {
  const templatesDir = join(ctx.pluginDir, 'dist/build/templates')

  const templateVariables: Record<string, string> = {
    '{{useRegionalBlobs}}': ctx.useRegionalBlobs.toString(),
  }

  // Adapter mode uses a dedicated template that works for both monorepo and non-monorepo setups
  if (ctx.useAdapter) {
    const template = await readFile(join(templatesDir, 'handler-adapter.tmpl.js'), 'utf-8')
    templateVariables['{{cwd}}'] =
      // eslint-disable-next-line no-negated-condition
      ctx.relativeAppDir.length !== 0 ? posixJoin(ctx.distDirParent) : ''
    return applyTemplateVariables(template, templateVariables)
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

    if (ctx.useAdapter) {
      await copyNextServerCodeFromAdapter(ctx)
    } else {
      await copyNextServerCode(ctx)
      await copyNextDependencies(ctx)
    }

    await copyHandlerDependencies(ctx)
    await writeHandlerManifest(ctx)
    await writeHandlerFile(ctx)

    if (!ctx.useAdapter) {
      await verifyHandlerDirStructure(ctx)
    }
  })
}
