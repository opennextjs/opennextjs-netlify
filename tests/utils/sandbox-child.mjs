// @ts-check

import { getLogger } from 'lambda-local'
import { loadFunction } from './lambda-helpers.mjs'

getLogger().level = 'alert'

/**
 * @type {import('./lambda-helpers.mjs').InvokeFunction | undefined}
 */
let invokeFunctionImpl

process.on(
  'message',
  /**
   * @param {any} msg
   */
  async (msg) => {
    if (msg?.action === 'exit') {
      process.exit(0)
    } else if (msg?.action === 'loadFunction') {
      const [ctx, options] = msg.args

      invokeFunctionImpl = await loadFunction(ctx, options)

      if (process.send) {
        process.send({
          action: 'loadedFunction',
        })
      }
    } else if (msg?.action === 'invokeFunction') {
      try {
        const [ctx, options] = msg.args

        if (!invokeFunctionImpl) {
          throw new Error('Function not loaded')
        }
        const result = await invokeFunctionImpl(options)

        if (process.send) {
          process.send({
            action: 'invokeFunctionResult',
            operationId: msg.operationId,
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
