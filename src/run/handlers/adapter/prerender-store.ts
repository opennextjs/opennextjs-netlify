// L4: prerender groups in the blob store: serving, freshness, regeneration, on-demand revalidation
// and fallback shells, see docs/request-layers.md.
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import type { ResolveRoutesResult } from '../../../adapter-runtime-shared/next-routing.js'
import {
  getPrerenderFallbackBlobKey,
  getPrerenderGroupBlobKey,
  getPrerenderGroupTags,
  type PrerenderGroupBlob,
} from '../../../shared/blob-types.cjs'
import { getMemoizedKeyValueStoreBackedByRegionalBlobStore } from '../../storage/storage.cjs'
import { getLogger, isBackgroundRevalidationRequest } from '../request-context.cjs'
import { encodeCacheTag, isAnyTagStaleOrExpired, purgeEdgeCache } from '../tags-handler.cjs'

import { finalize } from './finalize.js'
import { invokeHandler } from './invoke.js'
import {
  basePath,
  computeOutputsById,
  manifest,
  type PrerenderGroup,
  type PrerenderOutput,
} from './manifest.js'
import { resumePrerender } from './ppr.js'
import type { InvokeOptions, Produced, ProduceRequest } from './types.js'

// like Next's isBot (shared/lib/router/utils/is-bot.ts): the app's `htmlLimitedBots`, which the
// config carries as a regex source, and Googlebot, which renders JavaScript
const htmlLimitedBotsRegex = manifest.config.htmlLimitedBots
  ? new RegExp(String(manifest.config.htmlLimitedBots), 'i')
  : undefined
function isBot(userAgent: string): boolean {
  return (
    /googlebot(?!-)|googlebot$/i.test(userAgent) || Boolean(htmlLimitedBotsRegex?.test(userAgent))
  )
}

export function getPrerenderGroupQuery(
  entry: PrerenderOutput,
  query: ResolveRoutesResult['resolvedQuery'],
): URLSearchParams {
  const params = new URLSearchParams()
  for (const key of entry.allowQuery ?? []) {
    const value = query?.[key]
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      params.append(key, item)
    }
  }
  return params
}

// Next's `s-maxage=R, stale-while-revalidate=E-R`; without s-maxage the response isn't cacheable
function parseNextCacheControl(
  cacheControl: string | undefined,
): Pick<PrerenderGroupBlob, 'revalidate' | 'expire'> | undefined {
  const directives = new Map(
    (cacheControl ?? '').split(',').map((directive) => {
      const [key, value] = directive.trim().split('=')
      return [key.toLowerCase(), value] as const
    }),
  )
  const sMaxAge = Number(directives.get('s-maxage'))
  if (!Number.isFinite(sMaxAge) || sMaxAge <= 0) {
    return
  }
  if (sMaxAge >= 31536000) {
    return { revalidate: false, expire: undefined }
  }
  const staleWhileRevalidate = Number(directives.get('stale-while-revalidate'))
  return {
    revalidate: sMaxAge,
    expire: Number.isFinite(staleWhileRevalidate) ? sMaxAge + staleWhileRevalidate : undefined,
  }
}

// `/fallback-true/[slug]` with `nxtPslug=hello` is `/fallback-true/hello`
function interpolatePrerenderPathname(pathname: string, params: URLSearchParams): string {
  return pathname.replace(/\/\[(\[)?(?:\.{3})?([^\]]+)]]?/g, (segment, optional, name: string) => {
    const values = params.getAll(`nxtP${name}`)
    if (values.length !== 0) {
      return `/${values.join('/')}`
    }
    return optional ? '' : segment
  })
}

async function regeneratePrerenderGroup(
  groupKey: string,
  group: Required<PrerenderGroup>,
  params: URLSearchParams,
  // `onDemandToken`: the regeneration is `res.revalidate()`, which Next reports as on-demand
  { onDemandToken, ...args }: ProduceRequest & { onDemandToken?: string },
): Promise<PrerenderGroupBlob> {
  const invocationId = randomUUID()
  // `allowQuery` (the group key) leaves out params the output pathname already fixes
  // (`/en/docs/[...parts]` has no `nxtPlang`), but Next only splits a catch-all into an array when
  // it gets all of them. Params left as placeholders stay out: they're shared by the group.
  const routeParams = new URLSearchParams(params)
  const requestParams = args.resolution.invocation?.requestMeta.params ?? {}
  for (const [name, value] of Object.entries(requestParams)) {
    const key = `nxtP${name}`
    if (!routeParams.has(key) && !new RegExp(`\\[(?:\\.{3})?${name}]`).test(group.entry.pathname)) {
      for (const item of [value].flat()) {
        routeParams.append(key, item)
      }
    }
  }
  const variants: PrerenderGroupBlob['variants'] = {}
  let postponed: string | undefined
  let entryHtml: string | undefined
  // a PPR shell is what Next caches, as the adapter PPR docs persist it: the response of a minimal
  // mode render isn't only the shell (in test mode it starts with the PPR boundary sentinel)
  const captureEntry: InvokeOptions['onCacheEntry'] = (entry) => {
    if (entry.value?.kind === 'APP_PAGE') {
      const { postponed: entryPostponed, html } = entry.value
      postponed = entryPostponed
      try {
        entryHtml = html?.toUnchunkedString?.()
      } catch {
        // a streamed (dynamic) render has no cached shell, the response has it all
      }
    }
  }
  // the entry first: its render fills Next's response cache for the other variants
  for (const member of [group.entry, ...group.members.filter((item) => item !== group.entry)]) {
    const output = computeOutputsById.get(member.parentOutputId)
    if (!output) {
      continue
    }
    const url = new URL(member.pathname, args.request.url)
    url.search = routeParams.toString()
    const memberRequest = new Request(url, {
      headers: onDemandToken ? { 'x-prerender-revalidate': onDemandToken } : {},
    })
    const response = await finalize(
      await invokeHandler(
        output,
        { ...args, request: memberRequest, resolution: {} },
        {
          invocationId,
          raw: true,
          ...(member === group.entry && { onCacheEntry: captureEntry }),
        },
      ),
      memberRequest,
    )
    const body = Buffer.from(await response.arrayBuffer())
    variants[member.pathname] = {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: (member === group.entry && postponed !== undefined && entryHtml !== undefined
        ? Buffer.from(entryHtml)
        : body
      ).toString('base64'),
    }
  }

  const entryHeaders = variants[group.entry.pathname]?.headers ?? {}
  const cacheControl = parseNextCacheControl(entryHeaders['cache-control'])
  const blob: PrerenderGroupBlob = {
    lastModified: Date.now(),
    revalidate: cacheControl?.revalidate ?? false,
    expire: cacheControl?.expire,
    tags: getPrerenderGroupTags(
      interpolatePrerenderPathname(group.entry.pathname, params),
      entryHeaders['x-next-cache-tags'],
      basePath,
    ),
    variants,
    postponed,
  }
  if (cacheControl) {
    const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })
    await store.set(groupKey, blob, 'prerenderGroup.set')
  }
  return blob
}

// `x-prerender-revalidate: <bypassToken>` (Pages Router `res.revalidate()`): regenerate now, and
// with `x-prerender-revalidate-if-generated` only a group generated before
export type OnDemandRevalidate = { onlyGenerated: boolean }

export async function getPrerenderGroupPostponed(
  group: Required<PrerenderGroup>,
  { resolution }: ProduceRequest,
): Promise<string | undefined> {
  const params = getPrerenderGroupQuery(
    group.entry,
    resolution.resolvedQuery ?? resolution.invocation?.requestMeta.query,
  )
  const paramsString = params.toString()
  const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })
  const blob = await store.get<PrerenderGroupBlob>(
    getPrerenderGroupBlobKey(
      paramsString ? `${group.entry.pathname}?${paramsString}` : group.entry.pathname,
    ),
    'prerenderGroup.get',
  )
  if (blob?.postponed !== undefined || !group.entry.fallbackShell) {
    return blob?.postponed
  }
  const shell = await store.get<PrerenderGroupBlob>(
    getPrerenderFallbackBlobKey(group.entry.pathname),
    'prerenderFallback.get',
  )
  return shell?.postponed
}

export async function servePrerenderGroup(
  variant: PrerenderOutput,
  group: Required<PrerenderGroup>,
  args: ProduceRequest,
  onDemand?: OnDemandRevalidate,
): Promise<Produced | undefined> {
  const { request, requestContext, resolution } = args
  const params = getPrerenderGroupQuery(
    group.entry,
    resolution.resolvedQuery ?? resolution.invocation?.requestMeta.query,
  )
  const paramsString = params.toString()
  const groupKey = getPrerenderGroupBlobKey(
    paramsString ? `${group.entry.pathname}?${paramsString}` : group.entry.pathname,
  )
  const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })
  let blob = await store.get<PrerenderGroupBlob>(groupKey, 'prerenderGroup.get')
  let nextCache: 'HIT' | 'STALE' | 'MISS' = 'HIT'

  if (onDemand) {
    if (onDemand.onlyGenerated && !blob) {
      return {
        kind: 'final',
        response: new Response('This page could not be found', { status: 404 }),
      }
    }
    blob = await regeneratePrerenderGroup(groupKey, group, params, {
      ...args,
      onDemandToken: group.entry.bypassToken,
    })
    // `res.revalidate()` resolves with this response: callers expect the CDN to be fresh by then
    await purgeEdgeCache(blob.tags.map(encodeCacheTag))
    nextCache = 'MISS'
  } else if (blob) {
    const age = (Date.now() - blob.lastModified) / 1000
    const tags = await isAnyTagStaleOrExpired(blob.tags, blob.lastModified)
    const expired = tags.expired || (blob.expire !== undefined && age > blob.expire)
    const stale = tags.stale || (blob.revalidate !== false && age > blob.revalidate)
    if (expired || (stale && isBackgroundRevalidationRequest(request))) {
      blob = null
    } else if (stale) {
      nextCache = 'STALE'
      requestContext.trackBackgroundWork(
        regeneratePrerenderGroup(groupKey, group, params, args).then(
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          () => {},
          (error) => getLogger().withError(error).error('prerender group regeneration error'),
        ),
      )
    }
  }

  if (
    !blob &&
    !onDemand &&
    group.entry.fallbackShell &&
    // like Next, crawlers get the page rendered instead
    !isBot(request.headers.get('user-agent') ?? '')
  ) {
    // like a CDN serving the prerender's fallback: the client then asks for the path's data, which
    // generates the group
    const shell = await store.get<PrerenderGroupBlob>(
      getPrerenderFallbackBlobKey(group.entry.pathname),
      'prerenderFallback.get',
    )
    const shellVariant = shell?.variants[variant.pathname]
    const isPartialFallback = shellVariant && shell?.postponed !== undefined
    if (isPartialFallback) {
      // PPR partial fallback: upgrade the shell to the path's own group in the background, a
      // segment prefetch served the shell's segment included (the router retries it)
      requestContext.trackBackgroundWork(
        regeneratePrerenderGroup(groupKey, group, params, args).then(
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          () => {},
          (error) => getLogger().withError(error).error('prerender group regeneration error'),
        ),
      )
    }
    if (isPartialFallback && variant === group.entry && group.entry.resumeHeaders) {
      // resume the shell for this request
      return resumePrerender(
        { variant, entry: group.entry, postponed: shell.postponed as string, stored: shellVariant },
        args,
      )
    }
    if (shellVariant) {
      const response = new Response(
        request.method === 'HEAD' ? null : Buffer.from(shellVariant.body, 'base64'),
        { status: shellVariant.status, headers: shellVariant.headers },
      )
      return { kind: 'shell', response }
    }
  }

  // a PPR group's `.rsc` has no body of its own (its output's fallback has no file): it's a resume
  if (
    blob &&
    !blob.variants[variant.pathname] &&
    blob.postponed !== undefined &&
    group.entry.resumeHeaders
  ) {
    const resumed = await resumePrerender(
      { variant, entry: group.entry, postponed: blob.postponed },
      args,
    )
    if (resumed) {
      return resumed
    }
  }

  if (!blob?.variants[variant.pathname]) {
    nextCache = 'MISS'
    blob = await regeneratePrerenderGroup(groupKey, group, params, args)
  }
  const stored = blob.variants[variant.pathname]
  if (!stored) {
    return
  }

  if (blob.postponed !== undefined && group.entry.resumeHeaders) {
    const resumed = await resumePrerender(
      { variant, entry: group.entry, postponed: blob.postponed, stored },
      args,
    )
    if (resumed) {
      return resumed
    }
  }

  const response = new Response(
    request.method === 'HEAD' ? null : Buffer.from(stored.body, 'base64'),
    { status: stored.status, headers: stored.headers },
  )
  response.headers.set('x-nextjs-cache', nextCache)
  return {
    kind: 'next',
    response,
    cache: {
      lastModified: nextCache === 'MISS' ? undefined : blob.lastModified,
      tags: stored.headers['x-next-cache-tags'] ? undefined : blob.tags.map(encodeCacheTag),
    },
  }
}
