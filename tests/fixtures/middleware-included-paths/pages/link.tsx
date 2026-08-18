import { useState, useEffect } from 'react'
import Link from 'next/link'

export default function Page() {
  const [isHydrated, setIsHydrated] = useState(false)
  useEffect(() => {
    setIsHydrated(true)
  }, [])

  return (
    <div>
      <h1>Link to page that should run middleware</h1>
      <p>
        <Link href="/test" data-link="test">
          getServerSideProps
        </Link>
      </p>
      <pre data-testid="hydration">{isHydrated ? 'hydrated' : 'hydrating'}</pre>
    </div>
  )
}
