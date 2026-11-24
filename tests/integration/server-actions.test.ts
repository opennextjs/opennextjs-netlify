import { getLogger } from 'lambda-local'
import { v4 } from 'uuid'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { type FixtureTestContext } from '../utils/contexts.js'
import { createFixture, loadSandboxedFunction, runPlugin } from '../utils/fixture.js'
import { generateRandomObjectID, startMockBlobStore } from '../utils/helpers.js'
import { LocalServer } from '../utils/local-server.js'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'

getLogger().level = 'alert'

beforeEach<FixtureTestContext>(async (ctx) => {
  ctx.deployID = generateRandomObjectID()
  ctx.siteID = v4()
  vi.stubEnv('SITE_ID', ctx.siteID)
  vi.stubEnv('DEPLOY_ID', ctx.deployID)
  vi.spyOn(console, 'debug').mockImplementation(() => {})

  await startMockBlobStore(ctx)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// Next.js derives the origin of a forwarded Server Action request from `initURL` since 16.2.11 / 15.5.21
test.skipIf(!nextVersionSatisfies('>=16.2.11 || >=15.5.21 <16.0.0'))<FixtureTestContext>(
  'Server Action forwarded to another worker targets the origin of the current request, not the one the server was started with',
  async (ctx) => {
    await createFixture('server-components', ctx)
    await runPlugin(ctx)

    const { invokeFunction, exit } = await loadSandboxedFunction(ctx)
    ctx.cleanup?.push(async () => exit())

    // Both domains are served by the same function instance, like a site with several domains.
    // Server Action forwarding makes a real network request, so these servers pass it back
    // into the function.
    const forwardedTo: string[] = []
    const serveDomain = (name: string) =>
      LocalServer.run(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        // bodies cross the sandbox boundary as strings, so leave out encoding and framing headers
        const skippedHeaders = new Set([
          'accept-encoding',
          'connection',
          'content-encoding',
          'content-length',
          'transfer-encoding',
        ])
        const pickHeaders = (headers: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(headers).filter(
              ([key, value]) => typeof value === 'string' && !skippedHeaders.has(key),
            ),
          ) as Record<string, string>
        const response = await invokeFunction({
          url: req.url,
          baseUrl: `http://${req.headers.host}`,
          httpMethod: req.method,
          // like Netlify's CDN, set x-forwarded-host to the domain that was actually requested
          headers: { ...pickHeaders(req.headers), 'x-forwarded-host': req.headers.host! },
          body: Buffer.concat(chunks).toString('utf-8'),
        })
        forwardedTo.push(`${name}: ${req.method} ${req.url} -> ${response.statusCode}`)
        res.writeHead(response.statusCode, pickHeaders(response.headers))
        res.end(response.body)
      })
    const startupDomain = await serveDomain('startupDomain')
    ctx.cleanup?.push(() => startupDomain.stop())
    const requestDomain = await serveDomain('requestDomain')
    ctx.cleanup?.push(() => requestDomain.stop())

    const startupOrigin = `http://localhost:${startupDomain.port}`
    const requestOrigin = `http://127.0.0.1:${requestDomain.port}`

    // first request starts the Next.js server with the hostname and port of this request
    const pageB = await invokeFunction({
      url: '/server-action-forwarding/b',
      baseUrl: startupOrigin,
    })
    expect(pageB.statusCode).toBe(200)
    // forms using a Server Action render its id in a hidden input, so they work without JavaScript
    const actionId = pageB.body.match(/\$ACTION_ID_([0-9a-f]+)/)?.[1]
    expect(actionId).toBeDefined()

    // subsequent request served by the same server, but on a different domain.
    // The action is only used on page B, so an action request to page A is forwarded to the page B worker
    const actionResponse = await invokeFunction({
      url: '/server-action-forwarding/a',
      baseUrl: requestOrigin,
      httpMethod: 'POST',
      headers: {
        host: new URL(requestOrigin).host,
        origin: requestOrigin,
        accept: 'text/x-component',
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': actionId!,
      },
      body: '[]',
    })

    expect.soft(actionResponse.statusCode).toBe(200)
    expect.soft(actionResponse.body).toContain('result from action')
    expect.soft(forwardedTo).toEqual(['requestDomain: POST /server-action-forwarding/b -> 200'])
  },
)
