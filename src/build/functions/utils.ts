import { stat } from 'node:fs/promises'
import { join as posixJoin, sep as posixSep } from 'node:path/posix'

import { trace } from '@opentelemetry/api'
import { wrapTracer } from '@opentelemetry/api/experimental'
// eslint-disable-next-line import/no-extraneous-dependencies
import AdmZip from 'adm-zip'
// eslint-disable-next-line import/no-extraneous-dependencies
import prettyBytes from 'pretty-bytes'

import { PluginContext, SERVER_HANDLER_NAME } from '../plugin-context.js'

const tracer = wrapTracer(trace.getTracer('Next runtime'))

/** Copies the runtime dist folder to the lambda */
export const checkBundleSize = async (ctx: PluginContext) => {
  const LAMBDA_MAX_SIZE = 1024 * 1024 * 250 // 250MB
  const TOP_N_ENTRIES = 5
  const LEVELS = 3

  await tracer.withActiveSpan('checkBundleSize', async () => {
    const bundleFileName: string = posixJoin(
      ctx.constants.FUNCTIONS_DIST,
      `${SERVER_HANDLER_NAME}.zip`,
    )
    const bundleSize = await stat(bundleFileName).then(({ size }) => size)
    if (bundleSize < LAMBDA_MAX_SIZE) {
      return
    }

    const zip = new AdmZip(bundleFileName)
    const bundleContentSizes: Record<string, number> = {}
    for (const entry of zip.getEntries()) {
      const entryName = entry.entryName.split(posixSep).slice(0, LEVELS).join(posixSep)
      bundleContentSizes[entryName] = (bundleContentSizes[entryName] || 0) + entry.header.size
    }

    // eslint-disable-next-line id-length
    const sortedBundleContentSizes = Object.entries(bundleContentSizes).sort((a, b) => b[1] - a[1])
    for (const [dir, size] of sortedBundleContentSizes.slice(0, TOP_N_ENTRIES)) {
      console.log(`${prettyBytes(size)} \t${dir}`)
    }
  })
}
