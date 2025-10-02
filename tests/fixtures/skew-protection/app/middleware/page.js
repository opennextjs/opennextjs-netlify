'use client'

import Link from 'next/link'
import { useState } from 'react'

export default function Page() {
  const [showLinks, setShowLinks] = useState(false)
  const [scopedMiddlewareEndpointResult, setScopedMiddlewareEndpointResult] = useState(null)
  const [unscopedMiddlewareEndpointResult, setUnscopedMiddlewareEndpointResult] = useState(null)

  return (
    <>
      <h1>Skew Protection Testing - Middleware</h1>
      <p>
        Current variant: <span data-testid="current-variant">{process.env.SKEW_VARIANT}</span>
      </p>
      <h2>
        <code>next/link</code>
      </h2>
      <div>
        {
          // Links are hidden initially, because as soon as link is in viewport, Next.js will prefetch it.
          // We want to control this because we do deploy swapping, so we only want links to be in viewport
          // after we do initial page load and then publish another deploy.
          // Otherwise prefetch could be triggered before deploy swap which would not be testing
          // skew protection.
        }
        <button data-testid="next-link-expand-button" onClick={() => setShowLinks(!showLinks)}>
          {showLinks ? 'Hide links' : 'Show links'} links
        </button>
        {showLinks && (
          <nav>
            <ul>
              <li>
                <Link href="/middleware/next" data-testid="next-link-linked-page-middleware-next">
                  <code>NextResponse.next()</code>
                </Link>
              </li>
              <li>
                <Link
                  href="/middleware/redirect"
                  data-testid="next-link-linked-page-middleware-redirect"
                >
                  <code>NextResponse.redirect()</code>
                </Link>
              </li>
              <li>
                <Link
                  href="/middleware/rewrite"
                  data-testid="next-link-linked-page-middleware-rewrite"
                >
                  <code>NextResponse.rewrite()</code>
                </Link>
              </li>
            </ul>
          </nav>
        )}
      </div>
      {
        // scoped here means that manual fetch call does include skew protection param which should lead to using same deployment version of middleware endpoint as one that served initial html to the browser
      }
      <h2>Fetching middleware endpoint (scoped)</h2>
      <div>
        <button
          data-testid="scoped-middleware-endpoint-button"
          onClick={async () => {
            setScopedMiddlewareEndpointResult(null)
            try {
              const response = await fetch('/middleware/json', {
                headers: {
                  'X-Deployment-Id': process.env.NEXT_DEPLOYMENT_ID,
                },
              })
              const result = await response.text()
              setScopedMiddlewareEndpointResult(result)
            } catch (err) {
              console.error(err)
              setScopedMiddlewareEndpointResult('Error: ' + (err.message || err.toString()))
            }
          }}
        >
          Test scoped middleware endpoint
        </button>
        {scopedMiddlewareEndpointResult && (
          <p>
            Scoped middleware endpoint result:
            <span data-testid="scoped-middleware-endpoint-result">
              {scopedMiddlewareEndpointResult}
            </span>
          </p>
        )}
      </div>
      {
        // unscoped here means that manual fetch call does NOT include skew protection param which should lead to using currently published deployment version of middleware endpoint
      }
      <h2>Fetching middleware endpoint (unscoped)</h2>
      <div>
        <button
          data-testid="unscoped-middleware-endpoint-button"
          onClick={async () => {
            setUnscopedMiddlewareEndpointResult(null)
            try {
              const response = await fetch('/middleware/json')
              const result = await response.text()
              setUnscopedMiddlewareEndpointResult(result)
            } catch (err) {
              console.error(err)
              setUnscopedMiddlewareEndpointResult('Error: ' + (err.message || err.toString()))
            }
          }}
        >
          Test unscoped middleware endpoint
        </button>
        {unscopedMiddlewareEndpointResult && (
          <p>
            Unscoped middleware endpoint result:
            <span data-testid="unscoped-middleware-endpoint-result">
              {unscopedMiddlewareEndpointResult}
            </span>
          </p>
        )}
      </div>
    </>
  )
}
