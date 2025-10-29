'use client'

import Link from 'next/link'
import { useState } from 'react'

export default function Page() {
  const [showLinks, setShowLinks] = useState(false)

  return (
    <>
      <h1>
        Skew Protection Testing - <code>next.config.js</code>
      </h1>
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
                <Link
                  href="/next-config/redirect"
                  data-testid="next-link-linked-page-next-config-redirect"
                >
                  <code>next.config.js#redirects</code>
                </Link>
              </li>
              <li>
                <Link
                  href="/next-config/rewrite"
                  data-testid="next-link-linked-page-next-config-rewrite"
                >
                  <code>next.config.js#rewrites</code>
                </Link>
              </li>
            </ul>
          </nav>
        )}
      </div>
    </>
  )
}
