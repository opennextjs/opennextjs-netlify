import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export async function middleware(request: NextRequest) {
  const response = getResponse(request)

  response.headers.set('Deno' in globalThis ? 'x-deno' : 'x-node', Date.now().toString())
  // report Next.js Middleware Runtime (not the execution runtime, but target runtime)
  // @ts-expect-error EdgeRuntime global not declared
  response.headers.set('x-runtime', typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : 'node')
  response.headers.set('x-hello-from-middleware-res', 'hello')

  return response
}

const getResponse = (request: NextRequest) => {
  const url = request.nextUrl

  // this is needed for tests to get the BUILD_ID
  if (url.pathname.startsWith('/_next/static/__BUILD_ID')) {
    return NextResponse.next()
  }

  if (url.pathname.startsWith('/link/next')) {
    return NextResponse.next({
      headers: {
        'x-middleware-test': 'link-next',
      },
    })
  }

  if (url.pathname.startsWith('/link/rewrite-me')) {
    const rewriteUrl = new URL(
      url.pathname.replace('/link/rewrite-me', '/link/rewrite-target'),
      url,
    )
    return NextResponse.rewrite(rewriteUrl, {
      headers: {
        'x-middleware-test': 'link-rewrite',
      },
    })
  }

  if (url.pathname === '/old-home') {
    if (url.searchParams.get('override') === 'external') {
      return NextResponse.redirect('https://example.vercel.sh')
    } else {
      url.pathname = '/new-home'
      return NextResponse.redirect(url)
    }
  }

  if (url.searchParams.get('foo') === 'bar') {
    url.pathname = '/new-home'
    url.searchParams.delete('foo')
    return NextResponse.redirect(url)
  }

  // Chained redirects
  if (url.pathname === '/redirect-me-alot') {
    url.pathname = '/redirect-me-alot-2'
    return NextResponse.redirect(url)
  }

  if (url.pathname === '/redirect-me-alot-2') {
    url.pathname = '/redirect-me-alot-3'
    return NextResponse.redirect(url)
  }

  if (url.pathname === '/redirect-me-alot-3') {
    url.pathname = '/redirect-me-alot-4'
    return NextResponse.redirect(url)
  }

  if (url.pathname === '/redirect-me-alot-4') {
    url.pathname = '/redirect-me-alot-5'
    return NextResponse.redirect(url)
  }

  if (url.pathname === '/redirect-me-alot-5') {
    url.pathname = '/redirect-me-alot-6'
    return NextResponse.redirect(url)
  }

  if (url.pathname === '/redirect-me-alot-6') {
    url.pathname = '/redirect-me-alot-7'
    return NextResponse.redirect(url)
  }

  if (url.pathname === '/redirect-me-alot-7') {
    url.pathname = '/new-home'
    return NextResponse.redirect(url)
  }

  // Infinite loop
  if (url.pathname === '/infinite-loop') {
    url.pathname = '/infinite-loop-1'
    return NextResponse.redirect(url)
  }

  if (url.pathname === '/infinite-loop-1') {
    url.pathname = '/infinite-loop'
    return NextResponse.redirect(url)
  }

  if (url.pathname === '/to') {
    url.pathname = url.searchParams.get('pathname')
    url.searchParams.delete('pathname')
    return NextResponse.redirect(url)
  }

  if (url.pathname === '/with-fragment') {
    console.log(String(new URL('/new-home#fragment', url)))
    return NextResponse.redirect(new URL('/new-home#fragment', url))
  }

  if (url.locale !== 'en' && url.pathname === '/redirect-to-same-page-but-default-locale') {
    url.locale = 'en'
    return NextResponse.redirect(url)
  }

  if (url.pathname.includes('/json')) {
    return NextResponse.json({
      requestUrlPathname: new URL(request.url).pathname,
      nextUrlPathname: request.nextUrl.pathname,
      nextUrlLocale: request.nextUrl.locale,
    })
  }

  return NextResponse.next()
}
