import process from 'node:process'

import type { Context } from '@netlify/edge-functions'

import type { NetlifyAdapterContext } from '../build/types.js'

type RoutingRuleBase = {
  /**
   * Human readable description of the rule (for debugging purposes only)
   */
  description: string
}

type Match = {
  /** Regex */
  path: string

  /** additional conditions */
  has?: {
    type: 'header'
    key: string
  }[]
}

export type RoutingRuleRedirect = RoutingRuleBase & {
  match: Match
  apply: {
    type: 'redirect'
    /** Can use capture groups from match.path */
    destination: string
    /** Allowed redirect status code, defaults to 307 if not defined */
    statusCode?: 301 | 302 | 307 | 308
  }
}

export type RoutingRuleRewrite = RoutingRuleBase & {
  match: Match
  apply: {
    type: 'rewrite'
    /** Can use capture groups from match.path */
    destination: string
    /** Forced status code for response, if not defined rewrite response status code will be used */
    statusCode?: 200 | 404 | 500
  }
}

export type RoutingRuleMatchPrimitive = RoutingRuleBase & {
  match: {
    type: 'static-asset-or-function' | 'middleware' | 'image-cdn'
  }
}

export type RoutingPhase = 'filesystem' | 'rewrite'

export type RoutingPhaseRule = RoutingRuleBase & {
  routingPhase: RoutingPhase
}

export type RoutingRule =
  | RoutingRuleRedirect
  | RoutingRuleRewrite
  | RoutingPhaseRule
  | RoutingRuleMatchPrimitive

export function testRedirectRewriteRule(rule: RoutingRuleRedirect, request: Request) {
  const sourceRegexp = new RegExp(rule.match.path)
  const { pathname } = new URL(request.url)
  if (sourceRegexp.test(pathname)) {
    const replaced = pathname.replace(sourceRegexp, rule.apply.destination)
    return { matched: true, replaced }
  }
  return { matched: false }
}

let requestCounter = 0

export async function runNextRouting(
  request: Request,
  context: Context,
  routingRules: RoutingRule[],
  outputs: NetlifyAdapterContext['preparedOutputs'],
) {
  if (request.headers.has('x-ntl-routing')) {
    // don't route multiple times for same request
    return
  }

  const prefix = `[${
    request.headers.get('x-nf-request-id') ??
    // for ntl serve, we use a combination of timestamp and pid to have a unique id per request as we don't have x-nf-request-id header then
    // eslint-disable-next-line no-plusplus
    `${Date.now()} - #${process.pid}:${++requestCounter}`
  }]`

  console.log(prefix, 'Incoming request for routing:', request.url)

  let currentRequest = new Request(request)
  currentRequest.headers.set('x-ntl-routing', '1')
  let maybeResponse: Response | undefined

  for (const rule of routingRules) {
    console.log(prefix, 'Evaluating rule:', rule.description ?? JSON.stringify(rule))
    if ('match' in rule) {
      const currentURL = new URL(currentRequest.url)
      const { pathname } = currentURL

      if ('type' in rule.match) {
        const pathnameToMatch = pathname === '/' ? '/index' : pathname

        if (rule.match.type === 'static-asset-or-function') {
          let matchedType: 'static-asset' | 'function' | null = null

          if (outputs.staticAssets.includes(pathnameToMatch)) {
            matchedType = 'static-asset'
          } else if (outputs.endpoints.includes(pathnameToMatch)) {
            matchedType = 'function'
          }

          if (matchedType) {
            console.log(prefix, `Matched static asset or function (${matchedType}):`)
            maybeResponse = await context.next(currentRequest)
          }
        } else if (rule.match.type === 'image-cdn' && pathname.startsWith('/.netlify/image/')) {
          console.log(prefix, 'Matched image cdn:', pathname)

          maybeResponse = await context.next(currentRequest)
        }
      } else if ('apply' in rule) {
        const sourceRegexp = new RegExp(rule.match.path)
        if (sourceRegexp.test(pathname)) {
          // check additional conditions
          if (rule.match.has) {
            let hasAllMatch = true
            for (const condition of rule.match.has) {
              if (condition.type === 'header' && !currentRequest.headers.has(condition.key)) {
                hasAllMatch = false
                break
              }
            }

            if (!hasAllMatch) {
              continue
            }
          }

          const replaced = pathname.replace(sourceRegexp, rule.apply.destination)

          if (rule.apply.type === 'rewrite') {
            console.log(prefix, `Rewriting ${pathname} to ${replaced}`)
            const destURL = new URL(replaced, currentURL)
            currentRequest = new Request(destURL, currentRequest)
          } else {
            console.log(prefix, `Redirecting ${pathname} to ${replaced}`)
            maybeResponse = new Response(null, {
              status: rule.apply.statusCode ?? 307,
              headers: {
                Location: replaced,
              },
            })
          }
        }
      }
    }

    if (maybeResponse) {
      // for debugging add log prefixes to response headers to make it easy to find logs for a given request
      maybeResponse.headers.set('x-ntl-log-prefix', prefix)
      console.log(prefix, 'Serving response', maybeResponse.status)
      return maybeResponse
    }
  }
}
