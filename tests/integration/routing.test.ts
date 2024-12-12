import { join as posixJoin } from 'node:path/posix'
import 'urlpattern-polyfill'
import { v4 } from 'uuid'
import { beforeEach, expect, test, vi } from 'vitest'
import { SERVER_HANDLER_NAME } from '../../src/build/plugin-context.js'
import { type FixtureTestContext } from '../utils/contexts.js'
import { createFixture, runPlugin } from '../utils/fixture.js'
import { generateRandomObjectID, startMockBlobStore } from '../utils/helpers.js'

const ssrRoutes = [
  ['/static', 'pages router, static rendering, static routing'],
  ['/prerendered', 'pages router, prerendering, static routing'],
  ['/posts/prerendered/1', 'pages router, prerendering, dynamic routing'],
  ['/dynamic', 'pages router, dynamic rendering, static routing'],
  ['/posts/dynamic/1', 'pages router, dynamic rendering, dynamic routing'],
  ['/api/okay', 'pages router, api route, static routing'],
  ['/api/posts/1', 'pages router, api route, dynamic routing'],
  ['/static-fetch-1', 'app router, prerendering, static routing'],
  ['/static-fetch/1', 'app router, prerendering, dynamic routing'],
  ['/static-fetch-dynamic-1', 'app router, dynamic rendering, static routing'],
  ['/static-fetch-dynamic/1', 'app router, dynamic rendering, dynamic routing'],
  ['/api/revalidate-handler', 'app router, route handler, static routing'],
  ['/api/static/1', 'app router, route handler, dynamic routing'],
]

const notFoundRoutes = [
  ['/non-existing', 'default'],
  ['/posts/prerendered/3', 'pages router, prerendering, dynamic routing'],
  ['/api/non-existing', 'pages router, api route, static routing'],
]

const baseURL = 'http://localhost'

beforeEach<FixtureTestContext>(async (ctx) => {
  // set for each test a new deployID and siteID
  ctx.deployID = generateRandomObjectID()
  ctx.siteID = v4()
  vi.stubEnv('DEPLOY_ID', ctx.deployID)

  await startMockBlobStore(ctx)
})

test<FixtureTestContext>('that the SSR handler routing works correctly', async (ctx) => {
  await createFixture('server-components', ctx)
  await runPlugin(ctx)

  const handler = await import(
    posixJoin(
      ctx.cwd,
      '.netlify/functions-internal',
      SERVER_HANDLER_NAME,
      `${SERVER_HANDLER_NAME}.mjs`,
    )
  )

  const matcher = (path: string) =>
    handler.config.path.some((pattern) =>
      new URLPattern({ pathname: pattern, baseURL }).test(posixJoin(baseURL, path)),
    )

  // check ssr routes are satisfied by the url patterns
  for (const [path, description] of ssrRoutes) {
    expect(path, `expected 200 response for ${description}`).toSatisfy(matcher)
  }

  // check not found routes are not satisfied by the url patterns
  for (const [path, description] of notFoundRoutes) {
    expect(path, `expected 404 response for ${description}`).not.toSatisfy(matcher)
  }
})
