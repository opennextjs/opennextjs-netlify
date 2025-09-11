import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { PluginContext } from './plugin-context.js'

export const setSkewProtection = async (ctx: PluginContext) => {
  if (!process.env.DEPLOY_ID || process.env.DEPLOY_ID === '0') {
    return
  }

  console.log('[Next Runtime] Setting up Next.js Skew Protection')

  process.env.NEXT_DEPLOYMENT_ID = process.env.DEPLOY_ID

  await mkdir(dirname(ctx.skewProtectionConfigPath), {
    recursive: true,
  })
  await writeFile(
    ctx.skewProtectionConfigPath,
    JSON.stringify(
      {
        patterns: ['.*'],
        sources: [
          {
            type: 'cookie',
            name: '__vdpl',
          },
          {
            type: 'header',
            name: 'X-Deployment-Id',
          },
          {
            type: 'query',
            name: 'dpl',
          },
        ],
      },
      null,
      2,
    ),
  )
}
