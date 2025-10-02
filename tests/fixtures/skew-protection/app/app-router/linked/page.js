import { ClientComponent } from './client-component'

export default function Page() {
  return (
    <>
      <h1>Skew Protection Testing - App Router - next/link navigation test</h1>
      <p>
        Current variant:{' '}
        <span data-testid="linked-page-server-component-current-variant">
          {process.env.SKEW_VARIANT}
        </span>
      </p>
      <ClientComponent />
    </>
  )
}
