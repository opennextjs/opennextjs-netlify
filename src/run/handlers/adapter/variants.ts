// Which output of a prerender group a request asks for (HTML, `.rsc`, a segment prefetch or a
// `_next/data` route), from Next's RSC transport headers and suffixes in the routing config.
import {
  basePath,
  manifest,
  prerenderGroups,
  type PrerenderOutput,
  prerendersByPathname,
} from './manifest.js'

// Routing resolves to the group's page output; which variant is asked for comes from the
// `routing.rsc` headers (a data request is resolved by routing itself)
export function getPrerenderVariant(
  resolvedPathname: string,
  headers: Headers,
  isDataRequest: boolean,
): PrerenderOutput | undefined {
  const output = prerendersByPathname.get(resolvedPathname)
  if (!output) {
    return
  }
  if (isDataRequest) {
    return prerenderGroups
      .get(output.groupId)
      ?.members.find((member) => member.pathname.startsWith(`${basePath}/_next/data/`))
  }
  const { rsc } = manifest
  if (!rsc || headers.get(rsc.header) !== '1') {
    return output
  }
  if (
    resolvedPathname.endsWith(rsc.suffix) ||
    resolvedPathname.endsWith(rsc.prefetchSegmentSuffix)
  ) {
    return output
  }
  const base = resolvedPathname === (basePath || '/') ? `${basePath}/index` : resolvedPathname
  const segment =
    headers.get(rsc.prefetchHeader) === '1' ? headers.get(rsc.prefetchSegmentHeader) : null
  if (segment) {
    const segmentOutput = prerendersByPathname.get(
      `${base}${rsc.prefetchSegmentDirSuffix}${segment}${rsc.prefetchSegmentSuffix}`,
    )
    if (segmentOutput) {
      return segmentOutput
    }
  }
  // like Vercel: a segment prefetch without a segment output gets the full RSC payload
  return prerendersByPathname.get(`${base}${rsc.suffix}`)
}
