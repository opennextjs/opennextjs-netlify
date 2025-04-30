import { type getStore } from '@netlify/blobs'
import { BlobsServer } from '@netlify/blobs/server'
import { type WriteStream } from 'node:fs'
import { MockInstance, TestContext } from 'vitest'

export interface FixtureTestContext extends TestContext {
  cwd: string
  siteID: string
  deployID: string
  blobStoreHost: string
  blobStorePort: number
  blobServer: BlobsServer
  blobServerGetSpy: MockInstance<Parameters<BlobsServer['get']>, ReturnType<BlobsServer['get']>>
  blobStore: ReturnType<typeof getStore>
  functionDist: string
  edgeFunctionPort: number
  edgeFunctionOutput: WriteStream
  cleanup?: (() => Promise<void>)[]
  debug?: boolean
}
