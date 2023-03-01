import https from 'https'

import { NodeRequestHandler, Options } from 'next/dist/server/next-server'

import { getNextServer, NextServerType } from './handlerUtils'

const NextServer: NextServerType = getNextServer()

interface NetlifyNextServerOptions extends Options {
  netlifyRevalidateToken: string
}

class NetlifyNextServer extends NextServer {
  private netlifyRevalidateToken?: string

  public constructor(options: NetlifyNextServerOptions) {
    super(options)
    this.netlifyRevalidateToken = options.netlifyRevalidateToken
  }

  public getRequestHandler(): NodeRequestHandler {
    const handler = super.getRequestHandler()
    return async (req, res, parsedUrl) => {
      if (req.headers['x-prerender-revalidate']) {
        if (this.netlifyRevalidateToken) {
          await this.netlifyRevalidate(req.url)
        } else {
          throw new Error(`Missing revalidate token`)
        }
      }
      return handler(req, res, parsedUrl)
    }
  }

  private netlifyRevalidate(url: string) {
    const domain = this.hostname
    const siteId = process.env.SITE_ID

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ paths: [url], domain })

      const req = https
        .request(
          {
            hostname: 'api.netlify.com',
            port: 443,
            path: `/api/v1/sites/${siteId}/refresh_on_demand_builders`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': body.length,
              Authorization: `Bearer ${this.netlifyRevalidateToken}`,
            },
          },
          (res) => {
            let data = ''
            res.on('data', (chunk) => {
              data += chunk
            })
            res.on('end', () => {
              resolve(JSON.parse(data))
            })
          },
        )
        .on('error', reject)

      req.write(body)
      req.end()
    })
  }
}

export { NetlifyNextServer }
