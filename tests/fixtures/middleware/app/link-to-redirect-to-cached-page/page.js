import Link from 'next/link'

export default function LinksToRedirectedCachedPage() {
  return (
    <nav>
      <ul>
        <li>
          <Link href="/test/redirect-to-cached-page">NextResponse.redirect</Link>
        </li>
      </ul>
    </nav>
  )
}
