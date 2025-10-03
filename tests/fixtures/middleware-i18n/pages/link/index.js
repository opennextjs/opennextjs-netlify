import { useState, useEffect } from 'react'
import Link from 'next/link'

export default function Page() {
  const [isHydrated, setIsHydrated] = useState(false)
  useEffect(() => {
    setIsHydrated(true)
  }, [])

  return (
    <div>
      <h1>Page with Links</h1>
      <ul>
        <li>
          NextResponse.next()
          <ul>
            <li>
              <Link
                href="/link/next-getserversideprops"
                data-link="NextResponse.next()#getServerSideProps"
              >
                getServerSideProps
              </Link>
            </li>

            <li>
              <Link href="/link/next-getstaticprops" data-link="NextResponse.next()#getStaticProps">
                getStaticProps
              </Link>
            </li>

            <li>
              <Link href="/link/next-fullystatic" data-link="NextResponse.next()#fullyStatic">
                fullyStatic
              </Link>
            </li>
          </ul>
        </li>
        <li>
          NextResponse.rewrite()
          <ul>
            <li>
              <Link
                href="/link/rewrite-me-getserversideprops"
                data-link="NextResponse.rewrite()#getServerSideProps"
              >
                getServerSideProps
              </Link>
            </li>

            <li>
              <Link
                href="/link/rewrite-me-getstaticprops"
                data-link="NextResponse.rewrite()#getStaticProps"
              >
                getStaticProps
              </Link>
            </li>

            <li>
              <Link
                href="/link/rewrite-me-fullystatic"
                data-link="NextResponse.rewrite()#fullyStatic"
              >
                fullyStatic
              </Link>
            </li>
          </ul>
        </li>
      </ul>
      <pre data-testid="hydration">{isHydrated ? 'hydrated' : 'hydrating'}</pre>
    </div>
  )
}
