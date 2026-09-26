import getPort from 'get-port'

import { getDeployStore } from '@netlify/blobs'
import { BlobsServer, Operation } from '@netlify/blobs/server'
import type { NetlifyPluginUtils } from '@netlify/build'
import { Buffer } from 'node:buffer'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, vi } from 'vitest'
import { BLOB_TOKEN } from './constants.mjs'
import { type FixtureTestContext } from './contexts'
import { createBlobContext } from './lambda-helpers.mjs'

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

export function countOfBlobServerGetsForKey(ctx: FixtureTestContext, key: string) {
  return getBlobServerGets(ctx).reduce(
    (acc, curr) => (toStandalonePageKey(curr) === key ? acc + 1 : acc),
    0,
  )
}

/**
 * Converts a string to base64 blob key
 */
export const encodeBlobKey = (key: string) => Buffer.from(key).toString('base64url')

/**
 * Converts a base64 blob key to a string
 */
export const decodeBlobKey = (key: string) => Buffer.from(key, 'base64url').toString('utf-8')

/**
 * Decodes a blob key to the key standalone mode stores a page under: adapter mode stores a page as
 * one blob per prerender group, prefixed `prerender-group:` (or `prerender-fallback:`). With
 * `encodedLength` only that much of the encoded key is kept, like `key.substring(0, 50)` would.
 */
export const decodePageBlobKey = (key: string, encodedLength?: number) => {
  const decoded = toStandalonePageKey(decodeBlobKey(key))
  return encodedLength ? decodeBlobKey(encodeBlobKey(decoded).substring(0, encodedLength)) : decoded
}

const isAdapterMode = Boolean(process.env.NETLIFY_NEXT_EXPERIMENTAL_ADAPTER)

// a group is keyed by its page, and the root page is `/` rather than `/index`
function toStandalonePageKey(key: string) {
  const pageKey = key.replace(/^prerender-(group|fallback):/, '')
  return pageKey === key || pageKey !== '/' ? pageKey : '/index'
}

/**
 * The blob key a page is stored under. In adapter mode that is its prerender group: pass
 * `adapterGroup` for a path of a route that isn't prerendered (`/posts/[id]?nxtPid=3`).
 */
export const pageBlobKey = (key: string, adapterGroup = key === '/index' ? '/' : key) =>
  encodeBlobKey(isAdapterMode ? `prerender-group:${adapterGroup}` : key)

/**
 * The HTML of a page's blob, `pathname` being its output pathname in adapter mode
 */
export const getPageHtml = (blob: any, pathname: string): string =>
  isAdapterMode
    ? Buffer.from(blob.variants[pathname].body, 'base64').toString('utf-8')
    : blob.value.html

/**
 * Keys standalone mode stores that adapter mode doesn't: the App Router not-found page is only
 * seeded when it is a prerender output
 */
export const withoutStandaloneOnlyKeys = (keys: string[]) =>
  isAdapterMode ? keys.filter((key) => key !== '/_not-found') : keys

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
