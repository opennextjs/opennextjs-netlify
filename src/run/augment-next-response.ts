import type { ServerResponse } from 'node:http'
import { isPromise } from 'node:util/types'

import type { NextApiResponse } from 'next'

import type { RequestContext } from './handlers/request-context.cjs'

type ResRevalidateMethod = NextApiResponse['revalidate']

function isRevalidateMethod(
  key: string,
  nextResponseField: unknown,
): nextResponseField is ResRevalidateMethod {
  return key === 'revalidate' && typeof nextResponseField === 'function'
}

function isAppendHeaderMethod(
  key: string,
  nextResponseField: unknown,
): nextResponseField is ServerResponse['appendHeader'] {
  return key === 'appendHeader' && typeof nextResponseField === 'function'
}

// Needing to proxy the response object to intercept:
//  - the revalidate call for on-demand revalidation on page routes
//  - prevent .appendHeader calls for location header to add duplicate values
export const augmentNextResponse = (response: ServerResponse, requestContext: RequestContext) => {
  return new Proxy(response, {
    get(target: ServerResponse, key: string) {
      const originalValue = Reflect.get(target, key)
      if (isRevalidateMethod(key, originalValue)) {
        return function newRevalidate(...args: Parameters<ResRevalidateMethod>) {
          requestContext.didPagesRouterOnDemandRevalidate = true

          const result = originalValue.apply(target, args)
          if (result && isPromise(result)) {
            requestContext.trackBackgroundWork(result)
          }

          return result
        }
      }

      if (isAppendHeaderMethod(key, originalValue)) {
        return function patchedAppendHeader(...args: Parameters<ServerResponse['appendHeader']>) {
          if (typeof args[0] === 'string' && (args[0] === 'location' || args[0] === 'Location')) {
            let existing = target.getHeader('location')
            if (typeof existing !== 'undefined') {
              if (!Array.isArray(existing)) {
                existing = [String(existing)]
              }
              if (existing.includes(String(args[1]))) {
                // if we already have that location header - bail early
                // appendHeader should return the target for chaining
                return target
              }
            }
          }

          return originalValue.apply(target, args)
        }
      }
      return originalValue
    },
  })
}
