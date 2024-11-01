import type { NextConfigComplete } from 'next/dist/server/config-shared.js'
import { v4 } from 'uuid'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { type FixtureTestContext } from '../../tests/utils/contexts.js'
import { generateRandomObjectID, startMockBlobStore } from '../../tests/utils/helpers.js'

import { createRequestContext, type RequestContext } from './handlers/request-context.cjs'
import { setCacheControlHeaders, setVaryHeaders } from './headers.js'

beforeEach<FixtureTestContext>(async (ctx) => {
  // set for each test a new deployID and siteID
  ctx.deployID = generateRandomObjectID()
  ctx.siteID = v4()
  vi.stubEnv('DEPLOY_ID', ctx.deployID)

  await startMockBlobStore(ctx)
})

describe('headers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('setVaryHeaders', () => {
    const defaultConfig = {
      basePath: '',
      i18n: null,
    } satisfies Partial<NextConfigComplete>

    const defaultUrl = 'https://example.com'

    describe('should set "netlify-vary" header', () => {
      test('with expected default value', () => {
        const headers = new Headers()
        const request = new Request(defaultUrl)
        vi.spyOn(headers, 'set')

        setVaryHeaders(headers, request, defaultConfig)

        expect(headers.set).toBeCalledWith(
          'netlify-vary',
          'query=__nextDataReq,header=x-nextjs-data|x-next-debug-logging,cookie=__prerender_bypass|__next_preview_data',
        )
      })

      test('with expected vary headers', () => {
        const givenHeaders = {
          vary: 'Accept, Accept-Language',
        }
        const headers = new Headers(givenHeaders)
        const request = new Request(defaultUrl)
        vi.spyOn(headers, 'set')

        setVaryHeaders(headers, request, defaultConfig)

        expect(headers.set).toBeCalledWith(
          'netlify-vary',
          'query=__nextDataReq,header=x-nextjs-data|x-next-debug-logging|Accept|Accept-Language,cookie=__prerender_bypass|__next_preview_data',
        )
      })

      test('with no languages if i18n config has localeDetection disabled', () => {
        const headers = new Headers()
        const request = new Request(defaultUrl)
        const config = {
          ...defaultConfig,
          i18n: {
            localeDetection: false,
            locales: ['en', 'de'],
            defaultLocale: 'default',
          },
        } satisfies Partial<NextConfigComplete>
        vi.spyOn(headers, 'set')

        setVaryHeaders(headers, request, config)

        expect(headers.set).toBeCalledWith(
          'netlify-vary',
          'query=__nextDataReq,header=x-nextjs-data|x-next-debug-logging,cookie=__prerender_bypass|__next_preview_data',
        )
      })

      test('with no languages if path is root index', () => {
        const headers = new Headers()
        const request = new Request(`${defaultUrl}/another/path`)
        const config = {
          ...defaultConfig,
          i18n: {
            locales: ['en', 'de'],
            defaultLocale: 'default',
          },
        }
        vi.spyOn(headers, 'set')

        setVaryHeaders(headers, request, config)

        expect(headers.set).toBeCalledWith(
          'netlify-vary',
          'query=__nextDataReq,header=x-nextjs-data|x-next-debug-logging,cookie=__prerender_bypass|__next_preview_data',
        )
      })

      test('with expected languages if i18n config has locales', () => {
        const headers = new Headers()
        const request = new Request(defaultUrl)
        const config = {
          ...defaultConfig,
          i18n: {
            locales: ['en', 'de', 'fr'],
            defaultLocale: 'default',
          },
        }
        vi.spyOn(headers, 'set')

        setVaryHeaders(headers, request, config)

        expect(headers.set).toBeCalledWith(
          'netlify-vary',
          'query=__nextDataReq,header=x-nextjs-data|x-next-debug-logging,language=en|de|fr,cookie=__prerender_bypass|__next_preview_data|NEXT_LOCALE',
        )
      })

      test('with expected languages if i18n config has locales and basePath matches the current path', () => {
        const headers = new Headers()
        const request = new Request(`${defaultUrl}/base/path`)
        const config = {
          ...defaultConfig,
          basePath: '/base/path',
          i18n: {
            locales: ['en', 'de', 'fr'],
            defaultLocale: 'default',
          },
        }
        vi.spyOn(headers, 'set')

        setVaryHeaders(headers, request, config)

        expect(headers.set).toBeCalledWith(
          'netlify-vary',
          'query=__nextDataReq,header=x-nextjs-data|x-next-debug-logging,language=en|de|fr,cookie=__prerender_bypass|__next_preview_data|NEXT_LOCALE',
        )
      })

      test('with user defined Netlify-Vary (catch-all query) being included', () => {
        const headers = new Headers({
          'Netlify-Vary': 'query,header=x-custom-header,language=es,country=es,cookie=ab_test',
        })
        const request = new Request(`${defaultUrl}/base/path`)
        const config = {
          ...defaultConfig,
          basePath: '/base/path',
          i18n: {
            locales: ['en', 'de', 'fr'],
            defaultLocale: 'default',
          },
        }
        vi.spyOn(headers, 'set')

        setVaryHeaders(headers, request, config)

        expect(headers.set).toBeCalledWith(
          'netlify-vary',
          'query,header=x-nextjs-data|x-next-debug-logging|x-custom-header,language=en|de|fr|es,cookie=__prerender_bypass|__next_preview_data|NEXT_LOCALE|ab_test,country=es',
        )
      })

      test('with user defined Netlify-Vary (manual query variation) being included', () => {
        const headers = new Headers({
          'Netlify-Vary':
            'query=item_id|page|per_page,header=x-custom-header,language=es,country=es,cookie=ab_test',
        })
        const request = new Request(`${defaultUrl}/base/path`)
        const config = {
          ...defaultConfig,
          basePath: '/base/path',
          i18n: {
            locales: ['en', 'de', 'fr'],
            defaultLocale: 'default',
          },
        }
        vi.spyOn(headers, 'set')

        setVaryHeaders(headers, request, config)

        expect(headers.set).toBeCalledWith(
          'netlify-vary',
          'query=__nextDataReq|item_id|page|per_page,header=x-nextjs-data|x-next-debug-logging|x-custom-header,language=en|de|fr|es,cookie=__prerender_bypass|__next_preview_data|NEXT_LOCALE|ab_test,country=es',
        )
      })
    })
  })

  describe('setCacheControlHeaders', () => {
    const defaultUrl = 'https://example.com'

    describe('route handler responses with a specified `revalidate` value', () => {
      test('should not set any headers if "cdn-cache-control" is present', () => {
        const givenHeaders = {
          'cdn-cache-control': 'public, max-age=0, must-revalidate',
        }
        const request = new Request(defaultUrl)
        const response = new Response(null, { headers: givenHeaders })
        vi.spyOn(response.headers, 'set')

        const ctx: RequestContext = { ...createRequestContext(), routeHandlerRevalidate: false }
        setCacheControlHeaders(response, request, ctx)

        expect(response.headers.set).toHaveBeenCalledTimes(0)
      })

      test('should not set any headers if "netlify-cdn-cache-control" is present', () => {
        const givenHeaders = {
          'netlify-cdn-cache-control': 'public, max-age=0, must-revalidate',
        }
        const request = new Request(defaultUrl)
        const response = new Response(null, { headers: givenHeaders })
        vi.spyOn(response.headers, 'set')

        const ctx: RequestContext = { ...createRequestContext(), routeHandlerRevalidate: false }
        setCacheControlHeaders(response, request, ctx)

        expect(response.headers.set).toHaveBeenCalledTimes(0)
      })

      test('should mark content as stale if "{netlify-,}cdn-cache-control" is not present and "x-nextjs-cache" is "STALE" (GET)', () => {
        const givenHeaders = {
          'x-nextjs-cache': 'STALE',
        }
        const request = new Request(defaultUrl)
        const response = new Response(null, { headers: givenHeaders })
        vi.spyOn(response.headers, 'set')

        const ctx: RequestContext = { ...createRequestContext(), routeHandlerRevalidate: false }
        setCacheControlHeaders(response, request, ctx)

        expect(response.headers.set).toHaveBeenCalledTimes(1)
        expect(response.headers.set).toHaveBeenNthCalledWith(
          1,
          'netlify-cdn-cache-control',
          'public, max-age=0, must-revalidate, durable',
        )
      })

      test('should mark content as stale if "{netlify-,}cdn-cache-control" is not present and "x-nextjs-cache" is "STALE" (HEAD)', () => {
        const givenHeaders = {
          'x-nextjs-cache': 'STALE',
        }
        const request = new Request(defaultUrl)
        const response = new Response(null, { headers: givenHeaders })
        vi.spyOn(response.headers, 'set')

        const ctx: RequestContext = { ...createRequestContext(), routeHandlerRevalidate: false }
        setCacheControlHeaders(response, request, ctx)

        expect(response.headers.set).toHaveBeenCalledTimes(1)
        expect(response.headers.set).toHaveBeenNthCalledWith(
          1,
          'netlify-cdn-cache-control',
          'public, max-age=0, must-revalidate, durable',
        )
      })

      test('should set durable SWC=1yr with 1yr TTL if "{netlify-,}cdn-cache-control" is not present and `revalidate` is `false` (HEAD)', () => {
        const request = new Request(defaultUrl, { method: 'HEAD' })
        const response = new Response()
        vi.spyOn(response.headers, 'set')

        const ctx: RequestContext = { ...createRequestContext(), routeHandlerRevalidate: false }
        setCacheControlHeaders(response, request, ctx)

        expect(response.headers.set).toHaveBeenCalledTimes(1)
        expect(response.headers.set).toHaveBeenNthCalledWith(
          1,
          'netlify-cdn-cache-control',
          's-maxage=31536000, stale-while-revalidate=31536000, durable',
        )
      })

      test('should set durable SWC=1yr with given TTL if "{netlify-,}cdn-cache-control" is not present and `revalidate` is a number (GET)', () => {
        const request = new Request(defaultUrl)
        const response = new Response()
        vi.spyOn(response.headers, 'set')

        const ctx: RequestContext = { ...createRequestContext(), routeHandlerRevalidate: 7200 }
        setCacheControlHeaders(response, request, ctx)

        expect(response.headers.set).toHaveBeenCalledTimes(1)
        expect(response.headers.set).toHaveBeenNthCalledWith(
          1,
          'netlify-cdn-cache-control',
          's-maxage=7200, stale-while-revalidate=31536000, durable',
        )
      })

      test('should set durable SWC=1yr with 1yr TTL if "{netlify-,}cdn-cache-control" is not present and `revalidate` is a number (HEAD)', () => {
        const request = new Request(defaultUrl, { method: 'HEAD' })
        const response = new Response()
        vi.spyOn(response.headers, 'set')

        const ctx: RequestContext = { ...createRequestContext(), routeHandlerRevalidate: 7200 }
        setCacheControlHeaders(response, request, ctx)

        expect(response.headers.set).toHaveBeenCalledTimes(1)
        expect(response.headers.set).toHaveBeenNthCalledWith(
          1,
          'netlify-cdn-cache-control',
          's-maxage=7200, stale-while-revalidate=31536000, durable',
        )
      })

      test('should not set any headers on POST request', () => {
        const request = new Request(defaultUrl, { method: 'POST' })
        const response = new Response()
        vi.spyOn(response.headers, 'set')

        const ctx: RequestContext = { ...createRequestContext(), routeHandlerRevalidate: false }
        setCacheControlHeaders(response, request, ctx)

        expect(response.headers.set).toHaveBeenCalledTimes(0)
      })
    })

    test('should not set any headers if "cache-control" is not set and "requestContext.usedFsReadForNonFallback" is not truthy', () => {
      const request = new Request(defaultUrl)
      const response = new Response()
      vi.spyOn(response.headers, 'set')

      setCacheControlHeaders(response, request, createRequestContext())

      expect(response.headers.set).toHaveBeenCalledTimes(0)
    })

    test('should set permanent, durable "netlify-cdn-cache-control" if "cache-control" is not set and "requestContext.usedFsReadForNonFallback" is truthy', () => {
      const request = new Request(defaultUrl)
      const response = new Response()
      vi.spyOn(response.headers, 'set')

      const requestContext = createRequestContext()
      requestContext.usedFsReadForNonFallback = true

      setCacheControlHeaders(response, request, requestContext)

      expect(response.headers.set).toHaveBeenNthCalledWith(
        1,
        'cache-control',
        'public, max-age=0, must-revalidate',
      )
      expect(response.headers.set).toHaveBeenNthCalledWith(
        2,
        'netlify-cdn-cache-control',
        'max-age=31536000, durable',
      )
    })

    test('should set permanent, durable "netlify-cdn-cache-control" if 404 response for URl ending in .php', () => {
      const request = new Request(`${defaultUrl}/admin.php`)
      const response = new Response(null, { status: 404 })
      vi.spyOn(response.headers, 'set')

      const requestContext = createRequestContext()
      requestContext.usedFsReadForNonFallback = true

      setCacheControlHeaders(response, request, requestContext)

      expect(response.headers.set).toHaveBeenNthCalledWith(
        1,
        'cache-control',
        'public, max-age=0, must-revalidate',
      )
      expect(response.headers.set).toHaveBeenNthCalledWith(
        2,
        'netlify-cdn-cache-control',
        'max-age=31536000, durable',
      )
    })

    test('should not set any headers if "cache-control" is set and "cdn-cache-control" is present', () => {
      const givenHeaders = {
        'cache-control': 'public, max-age=0, must-revalidate',
        'cdn-cache-control': 'public, max-age=0, must-revalidate',
      }
      const request = new Request(defaultUrl)
      const response = new Response(null, { headers: givenHeaders })
      vi.spyOn(response.headers, 'set')

      setCacheControlHeaders(response, request, createRequestContext())

      expect(response.headers.set).toHaveBeenCalledTimes(0)
    })

    test('should not set any headers if "cache-control" is set and "netlify-cdn-cache-control" is present', () => {
      const givenHeaders = {
        'cache-control': 'public, max-age=0, must-revalidate',
        'netlify-cdn-cache-control': 'public, max-age=0, must-revalidate',
      }
      const request = new Request(defaultUrl)
      const response = new Response(null, { headers: givenHeaders })
      vi.spyOn(response.headers, 'set')

      setCacheControlHeaders(response, request, createRequestContext())

      expect(response.headers.set).toHaveBeenCalledTimes(0)
    })

    test('should set expected headers if "cache-control" is set and "cdn-cache-control" and "netlify-cdn-cache-control" are not present (GET request)', () => {
      const givenHeaders = {
        'cache-control': 'public, max-age=0, must-revalidate',
      }
      const request = new Request(defaultUrl)
      const response = new Response(null, { headers: givenHeaders })
      vi.spyOn(response.headers, 'set')

      setCacheControlHeaders(response, request, createRequestContext())

      expect(response.headers.set).toHaveBeenNthCalledWith(
        1,
        'cache-control',
        'public, max-age=0, must-revalidate',
      )
      expect(response.headers.set).toHaveBeenNthCalledWith(
        2,
        'netlify-cdn-cache-control',
        'public, max-age=0, must-revalidate, durable',
      )
    })

    test('should set expected headers if "cache-control" is set and "cdn-cache-control" and "netlify-cdn-cache-control" are not present (HEAD request)', () => {
      const givenHeaders = {
        'cache-control': 'public, max-age=0, must-revalidate',
      }
      const request = new Request(defaultUrl, { method: 'HEAD' })
      const response = new Response(null, { headers: givenHeaders })
      vi.spyOn(response.headers, 'set')

      setCacheControlHeaders(response, request, createRequestContext())

      expect(response.headers.set).toHaveBeenNthCalledWith(
        1,
        'cache-control',
        'public, max-age=0, must-revalidate',
      )
      expect(response.headers.set).toHaveBeenNthCalledWith(
        2,
        'netlify-cdn-cache-control',
        'public, max-age=0, must-revalidate, durable',
      )
    })

    test('should not set any headers on POST request', () => {
      const givenHeaders = {
        'cache-control': 'public, max-age=0, must-revalidate',
      }
      const request = new Request(defaultUrl, { method: 'POST' })
      const response = new Response(null, { headers: givenHeaders })
      vi.spyOn(response.headers, 'set')

      setCacheControlHeaders(response, request, createRequestContext())

      expect(response.headers.set).toHaveBeenCalledTimes(0)
    })

    test('should remove "s-maxage" from "cache-control" header', () => {
      const givenHeaders = {
        'cache-control': 'public, s-maxage=604800',
      }
      const request = new Request(defaultUrl)
      const response = new Response(null, { headers: givenHeaders })
      vi.spyOn(response.headers, 'set')

      setCacheControlHeaders(response, request, createRequestContext())

      expect(response.headers.set).toHaveBeenNthCalledWith(1, 'cache-control', 'public')
      expect(response.headers.set).toHaveBeenNthCalledWith(
        2,
        'netlify-cdn-cache-control',
        'public, s-maxage=604800, durable',
      )
    })

    test('should remove "stale-while-revalidate" from "cache-control" header', () => {
      const givenHeaders = {
        'cache-control': 'max-age=604800, stale-while-revalidate=86400',
      }
      const request = new Request(defaultUrl)
      const response = new Response(null, { headers: givenHeaders })
      vi.spyOn(response.headers, 'set')

      setCacheControlHeaders(response, request, createRequestContext())

      expect(response.headers.set).toHaveBeenNthCalledWith(1, 'cache-control', 'max-age=604800')
      expect(response.headers.set).toHaveBeenNthCalledWith(
        2,
        'netlify-cdn-cache-control',
        'max-age=604800, stale-while-revalidate=86400, durable',
      )
    })

    test('should set default "cache-control" header if it contains only "s-maxage" and "stale-while-revalidate"', () => {
      const givenHeaders = {
        'cache-control': 's-maxage=604800, stale-while-revalidate=86400',
      }
      const request = new Request(defaultUrl)
      const response = new Response(null, { headers: givenHeaders })
      vi.spyOn(response.headers, 'set')

      setCacheControlHeaders(response, request, createRequestContext())

      expect(response.headers.set).toHaveBeenNthCalledWith(
        1,
        'cache-control',
        'public, max-age=0, must-revalidate',
      )
      expect(response.headers.set).toHaveBeenNthCalledWith(
        2,
        'netlify-cdn-cache-control',
        's-maxage=604800, stale-while-revalidate=86400, durable',
      )
    })
  })
})
