import Link from 'next/link'

export default function LinksToRewrittenCachedPage() {
  return (
    <nav>
      <ul>
        <li>
          <Link href="/test/rewrite-to-cached-page">NextResponse.rewrite</Link>
        </li>
      </ul>
    </nav>
  )
}
