import { useState } from 'react'
import Link from 'next/link'

export default function Page() {
  const [showLinks, setShowLinks] = useState(false)
  const [unscopedApiRouteResult, setUnscopedApiRouteResult] = useState(null)
  const [scopedApiRouteResult, setScopedApiRouteResult] = useState(null)

  return (
    <>
      <h1>Skew Protection Testing - Pages Router</h1>
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
                <Link href="/pages-router/linked-static" data-testid="next-link-fully-static">
                  Go to /pages/linked-static Page
                </Link>
              </li>
              <li>
                <Link
                  href="/pages-router/linked-getStaticProps"
                  data-testid="next-link-getStaticProps"
                >
                  Go to /pages/linked-getStaticProps Page
                </Link>
              </li>
              <li>
                <Link
                  href="/pages-router/linked-getServerSideProps"
                  data-testid="next-link-getServerSideProps"
                >
                  Go to /pages/linked-getServerSideProps Page
                </Link>
              </li>
            </ul>
          </nav>
        )}
      </div>
      {
        // scoped here means that manual fetch call does include skew protection param which should lead to using same deployment version of api route as one that served initial html to the browser
      }
      <h2>Fetching API route (scoped)</h2>
      <div>
        <button
          data-testid="scoped-api-route-button"
          onClick={async () => {
            setScopedApiRouteResult(null)
            try {
              const response = await fetch('/api/api-route', {
                headers: {
                  'X-Deployment-Id': process.env.NEXT_DEPLOYMENT_ID,
                },
              })
              const result = await response.text()
              setScopedApiRouteResult(result)
            } catch (err) {
              console.error(err)
              setScopedApiRouteResult('Error: ' + (err.message || err.toString()))
            }
          }}
        >
          Test scoped API route
        </button>
        {scopedApiRouteResult && (
          <p>
            Scoped API route result:
            <span data-testid="scoped-api-route-result">{scopedApiRouteResult}</span>
          </p>
        )}
      </div>
      {
        // unscoped here means that manual fetch call does NOT include skew protection param which should lead to using currently published deployment version of api route
      }
      <h2>Fetching API route (unscoped)</h2>
      <div>
        <button
          data-testid="unscoped-api-route-button"
          onClick={async () => {
            setUnscopedApiRouteResult(null)
            try {
              const response = await fetch('/api/api-route')
              const result = await response.text()
              setUnscopedApiRouteResult(result)
            } catch (err) {
              console.error(err)
              setUnscopedApiRouteResult('Error: ' + (err.message || err.toString()))
            }
          }}
        >
          Test unscoped API route
        </button>
        {unscopedApiRouteResult && (
          <p>
            Unscoped API route result:
            <span data-testid="unscoped-api-route-result">{unscopedApiRouteResult}</span>
          </p>
        )}
      </div>
    </>
  )
}
