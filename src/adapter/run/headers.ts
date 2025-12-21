const getHeaderValueArray = (header: string): string[] => {
  return header
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

const omitHeaderValues = (header: string, values: string[]): string => {
  const headerValues = getHeaderValueArray(header)
  const filteredValues = headerValues.filter(
    (value) => !values.some((val) => value.startsWith(val)),
  )
  return filteredValues.join(', ')
}

export function generateAdapterCacheControl(headers: Headers) {
  const cacheControl = headers.get('cache-control')
  if (!cacheControl) {
    return
  }

  // move cache-control to cdn-cache-control
  if (
    !headers.has('cdn-cache-control') &&
    !headers.has('netlify-cdn-cache-control') &&
    !headers.has('adapter-cdn-cache-control')
  ) {
    // handle CDN Cache Control on ISR and App Router page responses
    const browserCacheControl = omitHeaderValues(cacheControl, [
      's-maxage',
      'stale-while-revalidate',
    ])
    const cdnCacheControl = [
      ...getHeaderValueArray(cacheControl).map((value) =>
        value === 'stale-while-revalidate' ? 'stale-while-revalidate=31536000' : value,
      ),
      'durable',
    ].join(', ')

    headers.set('cache-control', browserCacheControl || 'public, max-age=0, must-revalidate')
    headers.set('adapter-cdn-cache-control', cdnCacheControl)
  }
}

export function determineFreshness(headers: Headers) {
  const cacheControl = headers.get('adapter-cdn-cache-control')
  const dateHeaderValue = headers.get('date')

  if (!cacheControl || !dateHeaderValue) {
    return 'miss'
  }

  const settings = {
    maxAge: undefined as number | undefined,
    staleWhileRevalidate: undefined as number | undefined,
    durable: false,
  }

  const values = getHeaderValueArray(cacheControl)
  for (const value of values) {
    const [directive, valuePart] = value.split('=')

    let numericValue: number | undefined

    if (valuePart) {
      const maybeNumber = Number.parseInt(valuePart)
      if (!Number.isNaN(maybeNumber)) {
        numericValue = maybeNumber
      }
    }

    switch (directive) {
      case 's-maxage': {
        settings.maxAge = numericValue
        break
      }
      case 'stale-while-revalidate': {
        settings.staleWhileRevalidate = numericValue
        break
      }

      // No default
    }
  }

  if (typeof settings.maxAge !== 'number') {
    return 'miss'
  }

  const date = Date.parse(dateHeaderValue)
  const now = Date.now()

  const age = (now - date) / 1000

  if (age <= settings.maxAge) {
    return 'fresh'
  }

  if (typeof settings.staleWhileRevalidate !== 'number') {
    return 'miss'
  }

  if (age <= settings.maxAge + settings.staleWhileRevalidate) {
    return 'stale'
  }

  return 'miss'
}
