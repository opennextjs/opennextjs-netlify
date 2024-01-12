import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { EdgeFunctionDefinition as NextDefinition } from 'next/dist/build/webpack/plugins/middleware-plugin.js'

import { EDGE_HANDLER_NAME, PluginContext } from '../plugin-context.js'

interface NetlifyDefinition {
  function: string
  name: string
  pattern: string
  cache?: 'manual'
  generator: string
}

interface NetlifyManifest {
  version: number
  functions: NetlifyDefinition[]
}

const writeEdgeManifest = async (ctx: PluginContext, manifest: NetlifyManifest) => {
  await mkdir(ctx.edgeFunctionsDir, { recursive: true })
  await writeFile(join(ctx.edgeFunctionsDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

const writeHandlerFile = async (ctx: PluginContext, { matchers, name }: NextDefinition) => {
  const handlerName = getHandlerName({ name })
  const handlerDirectory = join(ctx.edgeFunctionsDir, handlerName)
  const handlerRuntimeDirectory = join(handlerDirectory, 'edge-runtime')

  // Copying the runtime files. These are the compatibility layer between
  // Netlify Edge Functions and the Next.js edge runtime.
  await cp(join(ctx.pluginDir, 'edge-runtime'), handlerRuntimeDirectory, {
    recursive: true,
  })

  // Writing a file with the matchers that should trigger this function. We'll
  // read this file from the function at runtime.
  await writeFile(join(handlerRuntimeDirectory, 'matchers.json'), JSON.stringify(matchers))

  // Writing the function entry file. It wraps the middleware code with the
  // compatibility layer mentioned above.
  await writeFile(
    join(handlerDirectory, `${handlerName}.js`),
    `
    import {handleMiddleware} from './edge-runtime/middleware.ts';
    import handler from './server/${name}.js';
    export default (req, context) => handleMiddleware(req, context, handler);
    `,
  )
}

const copyHandlerDependencies = async (ctx: PluginContext, { name, files }: NextDefinition) => {
  const edgeRuntimePath = join(ctx.pluginDir, 'edge-runtime')
  const srcDir = ctx.resolve('.next/standalone/.next')
  const shimPath = join(edgeRuntimePath, 'shim/index.js')
  const shim = await readFile(shimPath, 'utf8')
  const imports = `import './edge-runtime-webpack.js';`
  const exports = `export default _ENTRIES["middleware_${name}"].default;`

  await Promise.all(
    files.map(async (file) => {
      const destDir = join(ctx.edgeFunctionsDir, getHandlerName({ name }))

      if (file === `server/${name}.js`) {
        const entrypoint = await readFile(join(srcDir, file), 'utf8')
        const parts = [shim, imports, entrypoint, exports]

        await mkdir(dirname(join(destDir, file)), { recursive: true })
        await writeFile(join(destDir, file), parts.join('\n;'))

        return
      }

      await cp(join(srcDir, file), join(destDir, file))
    }),
  )
}

const createEdgeHandler = async (ctx: PluginContext, definition: NextDefinition): Promise<void> => {
  await copyHandlerDependencies(ctx, definition)
  await writeHandlerFile(ctx, definition)
}

const getHandlerName = ({ name }: Pick<NextDefinition, 'name'>): string =>
  `${EDGE_HANDLER_NAME}-${name.replace(/\W/g, '-')}`

const buildHandlerDefinition = (
  ctx: PluginContext,
  { name, matchers, page }: NextDefinition,
): NetlifyDefinition => ({
  function: getHandlerName({ name }),
  name: name === 'middleware' ? 'Next.js Middleware Handler' : `Next.js Edge Handler: ${page}`,
  pattern: matchers[0].regexp,
  cache: name === 'middleware' ? undefined : 'manual',
  generator: `${ctx.pluginName}@${ctx.pluginVersion}`,
})

export const createEdgeHandlers = async (ctx: PluginContext) => {
  await rm(ctx.edgeFunctionsDir, { recursive: true, force: true })

  const nextManifest = await ctx.getMiddlewareManifest()
  const nextDefinitions = [
    ...Object.values(nextManifest.middleware),
    // ...Object.values(nextManifest.functions)
  ]
  await Promise.all(nextDefinitions.map((def) => createEdgeHandler(ctx, def)))

  const netlifyDefinitions = nextDefinitions.map((def) => buildHandlerDefinition(ctx, def))
  const netlifyManifest = {
    version: 1,
    functions: netlifyDefinitions,
  }
  await writeEdgeManifest(ctx, netlifyManifest)
}