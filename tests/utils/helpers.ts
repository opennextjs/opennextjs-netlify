import getPort from 'get-port'

import { getDeployStore } from '@netlify/blobs'
import { BlobsServer } from '@netlify/blobs/server'
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
  ctx.blobServer = new BlobsServer({
    port,
    token: BLOB_TOKEN,
    directory: await mkdtemp(join(tmpdir(), 'opennextjs-netlify-blob-')),
  })
  await ctx.blobServer.start()
  ctx.blobServerGetSpy = vi.spyOn(ctx.blobServer, 'get')
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

export const getFrameworksAPIBlobEntries = async (ctx: FixtureTestContext) => {
  const blobDir = join(ctx.cwd, '.netlify', 'v1', 'blobs', 'deploy')
  const files = await glob('**/*', {
    dot: true,
    cwd: blobDir,
  })
  return files.map((key) => ({ key, etag: '', last_modified: '', size: 0 }))
}

export function getBlobServerGets(ctx: FixtureTestContext, predicate?: (key: string) => boolean) {
  const isString = (arg: unknown): arg is string => typeof arg === 'string'
  return ctx.blobServerGetSpy.mock.calls
    .map(([request]) => {
      if (typeof request.url !== 'string') {
        return undefined
      }

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
  return getBlobServerGets(ctx).reduce((acc, curr) => (curr === key ? acc + 1 : acc), 0)
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
