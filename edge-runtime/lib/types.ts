import type MiddlewareModule from 'next-with-adapters/dist/build/templates/middleware.js'

type NextHandler = (typeof MiddlewareModule)['default']

type RequestData = Parameters<NextHandler>[0]['request']

export type { NextHandler, RequestData }
