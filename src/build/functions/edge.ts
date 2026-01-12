import { rm } from 'node:fs/promises'

import { PluginContext } from '../plugin-context.js'

export const clearStaleEdgeHandlers = async (ctx: PluginContext) => {
  await rm(ctx.edgeFunctionsDir, { recursive: true, force: true })
}
