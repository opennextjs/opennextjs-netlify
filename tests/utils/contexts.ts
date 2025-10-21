import type { getStore } from '@netlify/blobs'
import { BlobsServer } from '@netlify/blobs/server'
import { type WriteStream } from 'node:fs'
import { TestContext } from 'vitest'

export interface FixtureTestContext extends TestContext {
  cwd: string
  siteID: string
  deployID: string
  blobStoreHost: string
  blobStorePort: number
  blobServer: BlobsServer
  blobServerOnRequestSpy: BlobsServer['onRequest']
  blobStore: ReturnType<typeof getStore>
  functionDist: string
  edgeFunctionPort: number
  edgeFunctionOutput: WriteStream
  cleanup?: (() => Promise<void>)[]
}
