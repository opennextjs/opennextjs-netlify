'use client'

export function ClientComponent() {
  return (
    <p>
      Client Component - variant:{' '}
      <span data-testid="linked-page-client-component-current-variant">
        {process.env.SKEW_VARIANT}
      </span>
    </p>
  )
}
