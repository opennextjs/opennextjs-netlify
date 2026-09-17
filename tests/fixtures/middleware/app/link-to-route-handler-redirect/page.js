import Link from 'next/link'

export default function LinkToRouteHandlerRedirect() {
  return (
    <nav>
      <ul>
        <li>
          <Link href="/api/redirect-to-public-prefix?ref=xyz" prefetch={false}>
            Route Handler redirect
          </Link>
        </li>
      </ul>
    </nav>
  )
}
