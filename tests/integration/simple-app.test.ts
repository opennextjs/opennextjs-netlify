import { load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { HttpResponse, http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { gt, prerelease } from 'semver'
import { v4 } from 'uuid'
import {
  Mock,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import { getPatchesToApply } from '../../src/build/content/server.js'
import { type FixtureTestContext } from '../utils/contexts.js'
import {
  createFixture,
  getFixtureSourceDirectory,
  invokeFunction,
  runPlugin,
} from '../utils/fixture.js'
import {
  decodeBlobKey,
  generateRandomObjectID,
  getBlobEntries,
  startMockBlobStore,
} from '../utils/helpers.js'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'

const mockedCp = cp as Mock<
  Parameters<(typeof import('node:fs/promises'))['cp']>,
  ReturnType<(typeof import('node:fs/promises'))['cp']>
>

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

test<FixtureTestContext>('Test that the simple next app is working', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)
  // check if the blob entries where successful set on the build plugin
  const blobEntries = await getBlobEntries(ctx)
  expect(blobEntries.map(({ key }) => decodeBlobKey(key)).sort()).toEqual([
    '/404',
    '/api/cached-permanent',
    '/api/cached-revalidate',
    '/image/local',
    '/image/migration-from-v4-runtime',
    '/image/remote-domain',
    '/image/remote-pattern-1',
    '/image/remote-pattern-2',
    '/index',
    '/other',
    '/route-resolves-to-not-found',
    '404.html',
    '500.html',
  ])

  // test the function call
  const home = await invokeFunction(ctx)
  expect(home.statusCode).toBe(200)
  expect(load(home.body)('h1').text()).toBe('Home')

  const other = await invokeFunction(ctx, { url: 'other' })
  expect(other.statusCode).toBe(200)
  expect(load(other.body)('h1').text()).toBe('Other')

  const notFound = await invokeFunction(ctx, { url: 'route-resolves-to-not-found' })
  expect(notFound.statusCode).toBe(404)
  // depending on Next version code found in 404 page can be either NEXT_NOT_FOUND or NEXT_HTTP_ERROR_FALLBACK
  // see https://github.com/vercel/next.js/commit/997105d27ebc7bfe01b7e907cd659e5e056e637c that moved from NEXT_NOT_FOUND to NEXT_HTTP_ERROR_FALLBACK
  expect(
    notFound.body?.includes('NEXT_NOT_FOUND') ||
      notFound.body?.includes('NEXT_HTTP_ERROR_FALLBACK'),
    '404 page should contain NEXT_NOT_FOUND or NEXT_HTTP_ERROR_FALLBACK code',
  ).toBe(true)

  const notExisting = await invokeFunction(ctx, { url: 'non-exisitng' })
  expect(notExisting.statusCode).toBe(404)
  expect(load(notExisting.body)('h1').text()).toBe('404 Not Found')
})

describe('verification', () => {
  test<FixtureTestContext>("Should warn if publish dir doesn't exist", async (ctx) => {
    await createFixture('simple', ctx)
    expect(() => runPlugin(ctx, { PUBLISH_DIR: 'no-such-directory' })).rejects.toThrowError(
      /Your publish directory was not found at: \S+no-such-directory. Please check your build settings/,
    )
  })

  test<FixtureTestContext>('Should warn if publish dir is root', async (ctx) => {
    await createFixture('simple', ctx)
    expect(() => runPlugin(ctx, { PUBLISH_DIR: '.' })).rejects.toThrowError(
      'Your publish directory cannot be the same as the base directory of your site. Please check your build settings',
    )
  })

  test<FixtureTestContext>('Should warn if publish dir is root (package path variant)', async (ctx) => {
    await createFixture('simple', ctx)
    expect(() =>
      runPlugin(ctx, { PUBLISH_DIR: 'app/.', PACKAGE_PATH: 'app' }),
    ).rejects.toThrowError(
      'Your publish directory cannot be the same as the base directory of your site. Please check your build settings',
    )
  })

  test<FixtureTestContext>('Should warn if publish dir is not set to Next.js output directory', async (ctx) => {
    await createFixture('simple', ctx)
    expect(() => runPlugin(ctx, { PUBLISH_DIR: 'public' })).rejects.toThrowError(
      'Your publish directory does not contain expected Next.js build output. Please check your build settings',
    )
  })
  test<FixtureTestContext>('Should not warn if using "out" as publish dir when output is "export"', async (ctx) => {
    await createFixture('output-export', ctx)
    await expect(runPlugin(ctx, { PUBLISH_DIR: 'out' })).resolves.not.toThrow()
  })

  test<FixtureTestContext>('Should not throw when using custom distDir and output is "export', async (ctx) => {
    await createFixture('output-export-custom-dist', ctx)
    await expect(runPlugin(ctx, { PUBLISH_DIR: 'custom-dist' })).resolves.not.toThrow()
  })
})

test<FixtureTestContext>('Should add cache-tags to prerendered app pages', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)

  const staticFetch1 = await invokeFunction(ctx, { url: '/other' })

  expect(staticFetch1.headers?.['netlify-cache-tag']).toBe(
    '_N_T_/layout,_N_T_/other/layout,_N_T_/other/page,_N_T_/other',
  )
})

test<FixtureTestContext>('index should be normalized within the cacheHandler and have cache-tags', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)
  const index = await invokeFunction(ctx, { url: '/' })
  expect(index.statusCode).toBe(200)
  expect(index.headers?.['netlify-cache-tag']).toBe('_N_T_/layout,_N_T_/page,_N_T_/')
})

// with 15.0.0-canary.187 and later Next.js no longer produce `stale-while-revalidate` directive
// for permanently cached response
test.skipIf(nextVersionSatisfies('>=15.0.0-canary.187'))<FixtureTestContext>(
  'stale-while-revalidate headers should be normalized to include delta-seconds',
  async (ctx) => {
    await createFixture('simple', ctx)
    await runPlugin(ctx)
    const index = await invokeFunction(ctx, { url: '/' })
    expect(index.headers?.['netlify-cdn-cache-control']).toContain(
      'stale-while-revalidate=31536000, durable',
    )
  },
)

test<FixtureTestContext>('404 responses for PHP pages should be cached indefinitely', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)
  const index = await invokeFunction(ctx, { url: '/admin.php' })
  expect(index.headers?.['netlify-cdn-cache-control']).toContain('max-age=31536000, durable')
})

test<FixtureTestContext>('handlers receive correct site domain', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)
  const index = await invokeFunction(ctx, { url: '/api/url' })
  const data = JSON.parse(index.body)
  const url = new URL(data.url)
  expect(url.hostname).toBe('example.netlify')
})

// adapted from https://github.com/vercel/next.js/blob/bd605245aae4c8545bdd38a597b89ad78ca3d978/test/e2e/app-dir/actions/app-action.test.ts#L119-L127
test<FixtureTestContext>('handlers can add cookies in route handlers with the correct overrides', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)
  const index = await invokeFunction(ctx, { url: '/api/headers' })
  expect(index.headers['content-type']).toEqual('text/custom')
  const setCookieHeader = index.headers['set-cookie']
  expect(setCookieHeader).toContain('bar=bar2; Path=/')
  expect(setCookieHeader).toContain('baz=baz2; Path=/')
  expect(setCookieHeader).toContain('foo=foo1; Path=/')
  expect(setCookieHeader).toContain('test1=value1; Path=/; Secure')
  expect(setCookieHeader).toContain('test2=value2; Path=/handler; HttpOnly')
})

test<FixtureTestContext>('cacheable route handler is cached on cdn (revalidate=false / permanent caching)', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)

  const permanentlyCachedResponse = await invokeFunction(ctx, { url: '/api/cached-permanent' })
  expect(permanentlyCachedResponse.headers['netlify-cdn-cache-control']).toBe(
    's-maxage=31536000, stale-while-revalidate=31536000, durable',
  )
})

test<FixtureTestContext>('purge API is not used when unstable_cache cache entry gets stale', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)

  // set the NETLIFY_PURGE_API_TOKEN to get pass token check and allow fetch call to be made
  vi.stubEnv('NETLIFY_PURGE_API_TOKEN', 'mock')

  const page1 = await invokeFunction(ctx, {
    url: '/unstable_cache',
  })
  const data1 = load(page1.body)('pre').text()

  // allow for cache entry to get stale
  await new Promise((res) => setTimeout(res, 2000))

  const page2 = await invokeFunction(ctx, {
    url: '/unstable_cache',
  })
  const data2 = load(page2.body)('pre').text()

  const page3 = await invokeFunction(ctx, {
    url: '/unstable_cache',
  })
  const data3 = load(page3.body)('pre').text()

  expect(purgeAPI, 'Purge API should not be hit').toHaveBeenCalledTimes(0)
  expect(
    data2,
    'Should use stale cache entry for current request and invalidate it in background',
  ).toBe(data1)
  expect(data3, 'Should use updated cache entry').not.toBe(data2)
})

test<FixtureTestContext>('cacheable route handler is cached on cdn (revalidate=15)', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)

  const firstTimeCachedResponse = await invokeFunction(ctx, { url: '/api/cached-revalidate' })
  // this will be "stale" response from build
  expect(firstTimeCachedResponse.headers['netlify-cdn-cache-control']).toBe(
    'public, max-age=0, must-revalidate, durable',
  )

  // allow server to regenerate fresh response in background
  await new Promise((res) => setTimeout(res, 1_000))

  const secondTimeCachedResponse = await invokeFunction(ctx, { url: '/api/cached-revalidate' })
  expect(secondTimeCachedResponse.headers['netlify-cdn-cache-control']).toBe(
    's-maxage=15, stale-while-revalidate=31536000, durable',
  )
})

// there's a bug where requests accept-encoding header
// result in corrupted bodies
// while that bug stands, we want to ignore accept-encoding
test<FixtureTestContext>('rewrites to external addresses dont use compression', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)
  const page = await invokeFunction(ctx, {
    url: '/rewrite-no-basepath',
    headers: { 'accept-encoding': 'gzip' },
  })
  expect(page.headers).not.toHaveProperty('content-length')
  expect(page.headers).not.toHaveProperty('transfer-encoding')
  expect(page.headers['content-encoding']).toBe('gzip')
  expect(gunzipSync(page.bodyBuffer).toString('utf-8')).toContain('<title>Example Domain</title>')
})

test.skipIf(process.env.NEXT_VERSION !== 'canary')<FixtureTestContext>(
  'Test that a simple next app with PPR is working',
  async (ctx) => {
    await createFixture('ppr', ctx)
    await runPlugin(ctx)
    // check if the blob entries where successful set on the build plugin
    const blobEntries = await getBlobEntries(ctx)
    expect(blobEntries.map(({ key }) => decodeBlobKey(key)).sort()).toEqual([
      '/404',
      '/index',
      '404.html',
      '500.html',
    ])

    // test the function call
    const home = await invokeFunction(ctx)
    expect(home.statusCode).toBe(200)
    expect(load(home.body)('h1').text()).toBe('Home')
  },
)

test<FixtureTestContext>('can require CJS module that is not bundled', async (ctx) => {
  await createFixture('simple', ctx)
  await runPlugin(ctx)

  const response = await invokeFunction(ctx, { url: '/api/cjs-file-with-js-extension' })

  expect(response.statusCode).toBe(200)

  const parsedBody = JSON.parse(response.body)

  expect(parsedBody.notBundledCJSModule.isBundled).toEqual(false)
  expect(parsedBody.bundledCJSModule.isBundled).toEqual(true)
})

describe('next patching', async () => {
  const { cp: originalCp, appendFile } = (await vi.importActual(
    'node:fs/promises',
  )) as typeof import('node:fs/promises')

  const { version: nextVersion } = createRequire(
    `${getFixtureSourceDirectory('simple')}/:internal:`,
  )('next/package.json')

  beforeAll(() => {
    process.env.NETLIFY_NEXT_FORCE_APPLY_ONGOING_PATCHES = 'true'
  })

  afterAll(() => {
    delete process.env.NETLIFY_NEXT_FORCE_APPLY_ONGOING_PATCHES
  })

  beforeEach(() => {
    mockedCp.mockClear()
    mockedCp.mockRestore()
  })

  test<FixtureTestContext>(`expected patches are applied and used (next version: "${nextVersion}")`, async (ctx) => {
    const patches = getPatchesToApply(nextVersion)

    await createFixture('simple', ctx)

    const fieldNamePrefix = `TEST_${Date.now()}`

    mockedCp.mockImplementation(async (...args) => {
      const returnValue = await originalCp(...args)
      if (typeof args[1] === 'string') {
        for (const patch of patches) {
          if (args[1].includes(join(patch.nextModule))) {
            // we append something to assert that patch file was actually used
            await appendFile(
              args[1],
              `;globalThis['${fieldNamePrefix}_${patch.nextModule}'] = 'patched'`,
            )
          }
        }
      }

      return returnValue
    })

    await runPlugin(ctx)

    // patched files was not used before function invocation
    for (const patch of patches) {
      expect(globalThis[`${fieldNamePrefix}_${patch.nextModule}`]).not.toBeDefined()
    }

    const home = await invokeFunction(ctx)
    // make sure the function does work
    expect(home.statusCode).toBe(200)
    expect(load(home.body)('h1').text()).toBe('Home')

    let shouldUpdateUpperBoundMessage = ''

    // file was used during function invocation
    for (const patch of patches) {
      expect(globalThis[`${fieldNamePrefix}_${patch.nextModule}`]).toBe('patched')

      if (patch.ongoing && !prerelease(nextVersion) && gt(nextVersion, patch.maxStableVersion)) {
        shouldUpdateUpperBoundMessage += `Ongoing ${shouldUpdateUpperBoundMessage ? '\n' : ''}"${patch.nextModule}" patch still works on "${nextVersion}" which is higher than currently set maxStableVersion ("${patch.maxStableVersion}"). Update maxStableVersion in "src/build/content/server.ts" for this patch to at least "${nextVersion}".`
      }
    }

    if (shouldUpdateUpperBoundMessage) {
      expect.fail(shouldUpdateUpperBoundMessage)
    }
  })
})
