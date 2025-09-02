import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // this middleware is using Node.js APIs that are not available in Edge Runtime in very simple way to assert support for them
  if (request.nextUrl.pathname === '/test/crypto') {
    return NextResponse.json({ random: randomBytes(16).toString('hex') })
  }

  if (request.nextUrl.pathname === '/test/http') {
    const body = await new Promise((resolve, reject) => {
      const origin =
        typeof Netlify !== 'undefined'
          ? `https://${Netlify.context.deploy.id}--${Netlify.context.site.name}.netlify.app`
          : `http://localhost:3000`

      const target = new URL('/http-test-target.json', origin)

      const httpOrHttpsRequest = target.protocol === 'https:' ? httpsRequest : httpRequest

      const req = httpOrHttpsRequest(target, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to fetch ${target}: ${res.statusCode}`))
          // Consume response data to free up memory
          res.resume()
          return
        }

        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(rawData))
          } catch (e) {
            reject(e)
          }
        })
      })
      req.end()
      console.log({ target })
    })
    return NextResponse.json({ proxiedWithHttpRequest: body })
  }

  if (request.nextUrl.pathname === '/test/path') {
    return NextResponse.json({ joined: join('a', 'b') })
  }
}

export const config = {
  runtime: 'nodejs',
}
