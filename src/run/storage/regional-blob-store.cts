import { getDeployStore, GetWithMetadataOptions, Store } from '@netlify/blobs'

const FETCH_BEFORE_NEXT_PATCHED_IT = Symbol.for('nf-not-patched-fetch')
const extendedGlobalThis = globalThis as typeof globalThis & {
  [FETCH_BEFORE_NEXT_PATCHED_IT]?: typeof globalThis.fetch
}

/**
 * Attempt to extract original fetch in case it was patched by Next.js already
 *
 * @see github.com/vercel/next.js/blob/fa214c74c1d8023098c0e94e57f917ef9f1afd1a/packages/next/src/server/lib/patch-fetch.ts#L986
 */
function attemptToGetOriginalFetch(
  fetch: typeof globalThis.fetch & {
    _nextOriginalFetch?: typeof globalThis.fetch
  },
) {
  return fetch._nextOriginalFetch ?? fetch
}

function forceOptOutOfUsingDataCache(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    return fetch(input, {
      ...init,
      next: {
        ...init?.next,
        // setting next.internal = true should prevent from trying to use data cache
        // https://github.com/vercel/next.js/blob/fa214c74c1d8023098c0e94e57f917ef9f1afd1a/packages/next/src/server/lib/patch-fetch.ts#L174
        // https://github.com/vercel/next.js/blob/fa214c74c1d8023098c0e94e57f917ef9f1afd1a/packages/next/src/server/lib/patch-fetch.ts#L210-L213
        // this is last line of defense in case we didn't manage to get unpatched fetch that will not affect
        // fetch if it's unpatched so it should be safe to apply always if we aren't sure if we use patched fetch

        // @ts-expect-error - this is an internal field that Next.js doesn't add to its global
        // type overrides for RequestInit type (like `next.revalidate` or `next.tags`)
        internal: true,
      },
    })
  }
}

export const setFetchBeforeNextPatchedIt = (fetch: typeof globalThis.fetch) => {
  // we store in globalThis in case we have multiple copies of this module
  // just as precaution

  extendedGlobalThis[FETCH_BEFORE_NEXT_PATCHED_IT] = forceOptOutOfUsingDataCache(
    attemptToGetOriginalFetch(fetch),
  )
}

const fetchBeforeNextPatchedItFallback = forceOptOutOfUsingDataCache(
  attemptToGetOriginalFetch(globalThis.fetch),
)
const getFetchBeforeNextPatchedIt = () =>
  extendedGlobalThis[FETCH_BEFORE_NEXT_PATCHED_IT] ?? fetchBeforeNextPatchedItFallback

export const getRegionalBlobStore = (args: GetWithMetadataOptions = {}): Store => {
  return getDeployStore({
    ...args,
    fetch: getFetchBeforeNextPatchedIt(),
    region: process.env.USE_REGIONAL_BLOBS?.toUpperCase() === 'TRUE' ? undefined : 'us-east-2',
  })
}
