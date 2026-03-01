import { load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { HttpResponse, http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { v4 } from 'uuid'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FixtureTestContext } from '../utils/contexts.js'
import {
  createFixture,
  EDGE_MIDDLEWARE_FUNCTION_NAME,
  invokeEdgeFunction,
  invokeFunction,
  runPlugin,
} from '../utils/fixture.js'
import { generateRandomObjectID, startMockBlobStore } from '../utils/helpers.js'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fsPromisesModule = (await importOriginal()) as typeof import('node:fs/promises')
  return {
    ...fsPromisesModule,
    cp: vi.fn(fsPromisesModule.cp.bind(fsPromisesModule)),
  }
})

let server: ReturnType<typeof setupServer>

// Disable the verbose logging of the lambda-local runtime
getLogger().level = 'alert'

const purgeAPI = vi.fn()

beforeAll(() => {
  server = setupServer(
    http.post('https://api.netlify.com/api/v1/purge', async ({ request }) => {
      purgeAPI(await request.json())

      return HttpResponse.json({
        ok: true,
      })
    }),
    http.all(/.*/, () => passthrough()),
  )
  server.listen()
})

afterAll(() => {
  // Disable API mocking after the tests are done.
  server.close()
})

beforeEach<FixtureTestContext>(async (ctx) => {
  // set for each test a new deployID and siteID
  ctx.deployID = generateRandomObjectID()
  ctx.siteID = v4()
  vi.stubEnv('SITE_ID', ctx.siteID)
  vi.stubEnv('DEPLOY_ID', ctx.deployID)
  // hide debug logs in tests
  vi.spyOn(console, 'debug').mockImplementation(() => {})

  purgeAPI.mockClear()

  await startMockBlobStore(ctx)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// https://github.com/vercel/next.js/pull/77808 makes turbopack builds no longer gated only to canaries
// allowing to run this test on both stable and canary versions of Next.js
describe.skipIf(
  // TODO(adapter): unskip when middleware is handled in the adapter
  !nextVersionSatisfies('>=15.3.0-canary.43'),
)('Test that the hello-world-turbopack next app is working', () => {
  test<FixtureTestContext>('regular page is working', async (ctx) => {
    await createFixture('hello-world-turbopack', ctx)
    await runPlugin(ctx)

    // test the function call
    const home = await invokeFunction(ctx)
    expect(home.statusCode).toBe(200)
    expect(load(home.body)('h1').text()).toBe('Hello, Next.js!')
  })

  test<FixtureTestContext>('edge page is working', async (ctx) => {
    await createFixture('hello-world-turbopack', ctx)
    await runPlugin(ctx)

    // test the function call
    const home = await invokeFunction(ctx, { url: '/edge-page' })
    expect(home.statusCode).toBe(200)
    expect(load(home.body)('h1').text()).toBe('Hello, Next.js!')
  })

  test<FixtureTestContext>('middleware is working', async (ctx) => {
    await createFixture('hello-world-turbopack', ctx)
    await runPlugin(ctx)

    const pathname = '/middleware/test'

    const response = await invokeEdgeFunction(ctx, {
      functions: [EDGE_MIDDLEWARE_FUNCTION_NAME],
      url: pathname,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      message: `Hello from middleware at ${pathname}`,
    })
  })
})
