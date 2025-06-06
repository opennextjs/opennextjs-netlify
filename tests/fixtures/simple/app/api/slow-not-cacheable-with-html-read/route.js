import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'

export async function GET() {
  // This adds intentional delay here to make it more likely to hit some next-server
  // initialization side-effects such as preloading page entries
  // and trying to assert that side-effects do NOT impact the response.
  // There is no way to force problematic side-effect scenario to happen without
  // modifying the next internals.
  // See https://github.com/vercel/next.js/blob/592401bb7fec83079716b2c9b090db580a63483f/packages/next/src/server/next-server.ts#L321-L327
  // which starts NOT awaited async work
  await new Promise((resolve) => setTimeout(resolve, 5_000))

  // This route handler variant also reads static html file to test an edge case
  // for our handler that tracks static html file reads to set CDN cache control
  const staticHTML = await readFile('static/prebuilt.html', 'utf-8')

  return NextResponse.json({
    message: `Not cacheable route handler using force-dynamic dynamic strategy that reads ${staticHTML.length} character long .html file`,
  })
}
export const dynamic = 'force-dynamic'
