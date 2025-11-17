import type NextHandlerFunc from 'next-with-adapters/dist/build/templates/middleware'

type NextHandler = typeof NextHandlerFunc

type RequestData = Parameters<NextHandler>[0]['request']

export type { NextHandler, RequestData }
