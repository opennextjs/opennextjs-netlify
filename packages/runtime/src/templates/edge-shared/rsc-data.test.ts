import { assertEquals } from 'https://deno.land/std@0.167.0/testing/asserts.ts'
import { describe, it } from 'https://deno.land/std@0.167.0/testing/bdd.ts'
import { getRscDataRouter, PrerenderManifest } from './rsc-data.ts'

const manifest: PrerenderManifest = {
  version: 3,
  routes: {},
  dynamicRoutes: {
    '/[...slug]': {
      routeRegex: '^/(.+?)(?:/)?$',
      fallback: null,
      dataRoute: '/[...slug].rsc',
      dataRouteRegex: '^/(.+?)\\.rsc$',
    },
  },
  notFoundRoutes: [],
}

const createContext = () => {
  let rewrittenTo: string | undefined

  return {
    context: {
      rewrite: (target: string) => {
        rewrittenTo = target
        return new Response('rewritten')
      },
    },
    get rewrittenTo() {
      return rewrittenTo
    },
  }
}

describe('getRscDataRouter', () => {
  it('rewrites anonymous RSC requests that match prerendered dynamic routes', () => {
    const router = getRscDataRouter(manifest)
    const rewriteContext = createContext()

    const response = router(
      new Request('https://example.netlify.app/dashboard', {
        headers: {
          RSC: '1',
        },
      }),
      rewriteContext.context as never,
    )

    assertEquals(response instanceof Response, true)
    assertEquals(rewriteContext.rewrittenTo, '/dashboard.rsc')
  })

  it('does not rewrite RSC requests with cookies', () => {
    const router = getRscDataRouter(manifest)
    const rewriteContext = createContext()

    const response = router(
      new Request('https://example.netlify.app/dashboard', {
        headers: {
          RSC: '1',
          Cookie: 'user=A',
        },
      }),
      rewriteContext.context as never,
    )

    assertEquals(response, void 0)
    assertEquals(rewriteContext.rewrittenTo, void 0)
  })

  it('does not rewrite RSC requests with authorization', () => {
    const router = getRscDataRouter(manifest)
    const rewriteContext = createContext()

    const response = router(
      new Request('https://example.netlify.app/dashboard', {
        headers: {
          RSC: '1',
          Authorization: 'Bearer user-a',
        },
      }),
      rewriteContext.context as never,
    )

    assertEquals(response, void 0)
    assertEquals(rewriteContext.rewrittenTo, void 0)
  })
})
