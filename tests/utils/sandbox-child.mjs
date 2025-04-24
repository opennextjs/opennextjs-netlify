// @ts-check

import { getLogger } from 'lambda-local'
import { loadAndInvokeFunctionImpl } from './lambda-helpers.mjs'

getLogger().level = 'alert'

process.on(
  'message',
  /**
   * @param {any} msg
   */
  async (msg) => {
    if (msg?.action === 'exit') {
      process.exit(0)
    } else if (msg?.action === 'invokeFunction') {
      try {
        const [ctx, options] = msg.args

        const result = await loadAndInvokeFunctionImpl(ctx, options)
        if (process.send) {
          process.send({
            action: 'invokeFunctionResult',
            result,
          })
        }
      } catch (e) {
        console.log('error', e)
        process.exit(1)
      }
    }
  },
)
