/**
 * @param {Request} request
 * @param {import('@netlify/edge-functions').Context} context
 */
export default async function ppr(request, context) {
  const start = Date.now()

  // might hit lambda or might hit cached response
  const res = await context.next()

  const pprPostponed = res.headers.get('x-ppr-request-body')
  const pprCacheKey = res.headers.get('x-ppr-cache-key')

  console.log({
    url: request.url,
    cacheStatus: res.headers.get('cache-status'),
    status: res.status,
    pprPostponed,
    pprCacheKey,
  })

  if (pprPostponed && pprCacheKey) {
    // init resume request
    const resumeResponsePromise = fetch(request.url, {
      method: 'POST',
      headers: {
        ...request.headers,
        'x-ppr-request-body': pprPostponed,
        'x-ppr-cache-key': pprCacheKey,
      },
    })

    const updatedHeaders = new Headers(res.headers)
    updatedHeaders.delete('x-ppr-request-body')
    updatedHeaders.delete('x-ppr-cache-key')
    updatedHeaders.set('x-ppr-merging', '1')

    const mergedBody = new ReadableStream({
      async start(controller) {
        const shellReader = res.body.getReader()
        while (true) {
          const { done, value } = await shellReader.read()
          if (done) {
            break
          }
          controller.enqueue(value)
        }
        controller.enqueue(
          new TextEncoder().encode(`\n<!-- POSTPONED INCOMING!! ${Date.now() - start}ms -->\n`),
        )
        const resumeResponse = await resumeResponsePromise
        const resumeReader = resumeResponse.body.getReader()
        while (true) {
          const { done, value } = await resumeReader.read()
          if (done) {
            break
          }
          controller.enqueue(value)
        }
        controller.enqueue(
          new TextEncoder().encode(`\n<!-- POSTPONED Attached!! ${Date.now() - start}ms -->\n`),
        )
        controller.close()
      },
    })

    return new Response(mergedBody, {
      ...mergedBody,
      headers: updatedHeaders,
    })
  }

  return res
}
