'use client'

import Link from 'next/link'
import { useState } from 'react'

import { testAction } from './actions'

export default function Page() {
  const [showLinks, setShowLinks] = useState(false)
  const [actionResult, setActionResult] = useState(null)
  const [scopedRouteHandlerResult, setScopedRouteHandlerResult] = useState(null)
  const [unscopedRouteHandlerResult, setUnscopedRouteHandlerResult] = useState(null)

  return (
    <>
      <h1>Skew Protection Testing - App Router</h1>
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
                <Link href="/app-router/linked" data-testid="next-link-linked-page">
                  next/link navigation test
                </Link>
              </li>
            </ul>
          </nav>
        )}
      </div>
      <h2>Server Action</h2>
      <div>
        <button
          data-testid="server-action-button"
          onClick={async () => {
            setActionResult(null)
            try {
              const result = await testAction()
              setActionResult(result)
            } catch (err) {
              console.error(err)
              setActionResult('Error: ' + (err.message || err.toString()))
            }
          }}
        >
          Test server action
        </button>
        {actionResult && (
          <p>
            Action result: <span data-testid="server-action-result">{actionResult}</span> (
            {actionResult === process.env.SKEW_VARIANT ? 'match' : 'mismatch'})
          </p>
        )}
      </div>
      {
        // scoped here means that manual fetch call does include skew protection param which should lead to using same deployment version of route handler as one that served initial html to the browser
      }
      <h2>Fetching route-handler (scoped)</h2>
      <div>
        <button
          data-testid="scoped-route-handler-button"
          onClick={async () => {
            setScopedRouteHandlerResult(null)
            try {
              const response = await fetch('/app-router/route-handler', {
                headers: {
                  'X-Deployment-Id': process.env.NEXT_DEPLOYMENT_ID,
                },
              })
              const result = await response.text()
              setScopedRouteHandlerResult(result)
            } catch (err) {
              console.error(err)
              setScopedRouteHandlerResult('Error: ' + (err.message || err.toString()))
            }
          }}
        >
          Test scoped route handler
        </button>
        {scopedRouteHandlerResult && (
          <p>
            Scoped route handler result:
            <span data-testid="scoped-route-handler-result">{scopedRouteHandlerResult}</span>
          </p>
        )}
      </div>
      {
        // unscoped here means that manual fetch call does NOT include skew protection param which should lead to using currently published deployment version of route handler
      }
      <h2>Fetching route-handler (unscoped)</h2>
      <div>
        <button
          data-testid="unscoped-route-handler-button"
          onClick={async () => {
            setUnscopedRouteHandlerResult(null)
            try {
              const response = await fetch('/app-router/route-handler')
              const result = await response.text()
              setUnscopedRouteHandlerResult(result)
            } catch (err) {
              console.error(err)
              setUnscopedRouteHandlerResult('Error: ' + (err.message || err.toString()))
            }
          }}
        >
          Test unscoped route handler
        </button>
        {unscopedRouteHandlerResult && (
          <p>
            Unscoped route handler result:
            <span data-testid="unscoped-route-handler-result">{unscopedRouteHandlerResult}</span>
          </p>
        )}
      </div>
    </>
  )
}
