import getPort from 'get-port'

import { getDeployStore } from '@netlify/blobs'
import { BlobsServer, Operation } from '@netlify/blobs/server'
import type { NetlifyPluginUtils } from '@netlify/build'
import { Buffer } from 'node:buffer'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, vi } from 'vitest'
import {
  getOwnerSourceRoute,
  getRouteCacheKey,
  isRouteCacheKey,
  ROUTE_CACHE_KEY_NEXT_VERSION_RANGE,
  type RouteCacheKind,
} from '../../src/shared/route-cache-key.cjs'
import { BLOB_TOKEN } from './constants.mjs'
import { type FixtureTestContext } from './contexts'
import { createBlobContext } from './lambda-helpers.mjs'
import { nextVersionSatisfies } from './next-version-helpers.mjs'

/**
 * Generates a 24char deploy ID (this is validated in the blob storage so we cant use a uuidv4)
 * @returns
 */
export const generateRandomObjectID = () => {
  const characters = 'abcdef0123456789'
  let objectId = ''

  for (let i = 0; i < 24; i++) {
    objectId += characters[Math.floor(Math.random() * characters.length)]
  }

  return objectId
}

/**
 * Starts a new mock blob storage
 * @param ctx
 */
export const startMockBlobStore = async (ctx: FixtureTestContext) => {
  const port = await getPort()
  // create new blob store server
  ctx.blobServerOnRequestSpy = vi.fn()
  ctx.blobServer = new BlobsServer({
    port,
    token: BLOB_TOKEN,
    onRequest: ctx.blobServerOnRequestSpy,
    directory: await mkdtemp(join(tmpdir(), 'opennextjs-netlify-blob-')),
  })
  await ctx.blobServer.start()
  ctx.blobStoreHost = `localhost:${port}`
  ctx.blobStorePort = port
  vi.stubEnv('NETLIFY_BLOBS_CONTEXT', createBlobContext(ctx))

  ctx.blobStore = getDeployStore({
    apiURL: `http://${ctx.blobStoreHost}`,
    deployID: ctx.deployID,
    siteID: ctx.siteID,
    token: BLOB_TOKEN,
  })
}

/**
 * Retrieves an array of blob store entries
 */
export const getBlobEntries = async (ctx: FixtureTestContext) => {
  ctx.blobStore = ctx.blobStore
    ? ctx.blobStore
    : getDeployStore({
        apiURL: `http://${ctx.blobStoreHost}`,
        deployID: ctx.deployID,
        siteID: ctx.siteID,
        token: BLOB_TOKEN,
      })

  const { blobs } = await ctx.blobStore.list()
  return blobs
}

export function getBlobServerGets(ctx: FixtureTestContext, predicate?: (key: string) => boolean) {
  const isString = (arg: unknown): arg is string => typeof arg === 'string'
  return ctx.blobServerOnRequestSpy.mock.calls
    .map(([request]) => {
      if (request.type !== Operation.GET) return undefined
      if (!isString(request.url)) return undefined

      let urlSegments = request.url.split('/').slice(1)

      // ignore region url component when using `experimentalRegion`
      const REGION_PREFIX = 'region:'
      if (urlSegments[0].startsWith(REGION_PREFIX)) {
        urlSegments = urlSegments.slice(1)
      }

      const [_siteID, _deployID, key] = urlSegments
      return key && decodeBlobKey(key)
    })
    .filter(isString)
    .filter((key) => !predicate || predicate(key))
}

/**
 * Reduces a (already decoded) blob key to the route it represents: a route-scoped key (15.5.27 /
 * 16.3.8+) becomes its pathname (keeping `/index`); any other key passes through unchanged.
 */
const stripRouteCacheScope = (decodedKey: string): string => {
  if (!isRouteCacheKey(decodedKey)) {
    return decodedKey
  }
  const marker = decodedKey.indexOf('/$/')
  return marker === -1 ? decodedKey : decodedKey.slice(marker + 2)
}

export function countOfBlobServerGetsForKey(ctx: FixtureTestContext, key: string) {
  return getBlobServerGets(ctx).reduce(
    (acc, curr) => (stripRouteCacheScope(curr) === key ? acc + 1 : acc),
    0,
  )
}

/**
 * Converts a string to base64 blob key
 */
export const encodeBlobKey = (key: string) => Buffer.from(key).toString('base64url')

/**
 * The (unencoded) cache key the runtime hands the cache handler for a response-cache entry, for the
 * Next version under test. From 15.5.27 / 16.3.8 the key is route-scoped (see
 * `src/shared/route-cache-key`); older Next uses the plain pathname. Use this where a test needs the
 * raw handler key (e.g. matching `CacheHandler.get` calls or `responseCacheKey`).
 */
export const routeCacheKeyFor = ({
  route,
  kind,
  sourceRoute = route,
}: {
  route: string
  kind: RouteCacheKind
  /** Owning route, e.g. `/post/[id]`; defaults to `route` for static routes. */
  sourceRoute?: string
}): string => {
  if (nextVersionSatisfies(ROUTE_CACHE_KEY_NEXT_VERSION_RANGE)) {
    return getRouteCacheKey(route, { kind, sourceRoute: getOwnerSourceRoute(sourceRoute, kind) })
  }
  return route === '/' ? '/index' : route
}

/**
 * The blob key the runtime stores a response-cache entry under (the encoded {@link routeCacheKeyFor}).
 * Use this in tests instead of hand-building `encodeBlobKey('/some/path')`.
 */
export const encodeBlobKeyForRoute = (args: Parameters<typeof routeCacheKeyFor>[0]): string =>
  encodeBlobKey(routeCacheKeyFor(args))

/**
 * The blob key a cache-tag manifest is stored under. Tags are keyed by the tag itself; the
 * route-scoping fix doesn't touch them (nor the fetch cache), so this is version-independent.
 */
export const encodeBlobKeyForTag = (tag: string): string => encodeBlobKey(tag)

/**
 * Converts a base64 blob key to a string
 */
export const decodeBlobKey = (key: string) => Buffer.from(key, 'base64url').toString('utf-8')

/**
 * Decodes a stored blob key back to the route / name it represents, for list assertions that must
 * work on both plain (old Next) and route-scoped (15.5.27 / 16.3.8+) keys. A route-scoped key is
 * reduced to its pathname (keeping `/index`); any other key (a plain route, a static `*.html` file, a
 * fetch entry, a tag) passes through unchanged.
 */
export const decodeBlobKeyToRoute = (key: string): string =>
  stripRouteCacheScope(decodeBlobKey(key))

/**
 * Fake build utils that are passed to a build plugin execution
 */
export const mockBuildUtils = {
  failBuild: (message: string, options: { error?: Error }) => {
    assert.fail(`${message}: ${options?.error || ''}`)
  },
  failPlugin: (message: string, options: { error?: Error }) => {
    assert.fail(`${message}: ${options?.error || ''}`)
  },
  cancelBuild: (message: string, options: { error?: Error }) => {
    assert.fail(`${message}: ${options?.error || ''}`)
  },
} as unknown as NetlifyPluginUtils
