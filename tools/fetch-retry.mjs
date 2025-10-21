// We are seeing quite a bit of 'fetch failed' cases in Github Actions that don't really reproduce
// locally. We are likely hitting some limits there when attempting to parallelize. They are not consistent
// so instead of reducing parallelism, we add a retry with backoff here.

const originalFetch = globalThis.fetch

const NUM_RETRIES = 5

globalThis.fetch = async (...args) => {
  let backoff = 100
  for (let attempt = 1; attempt <= NUM_RETRIES; attempt++) {
    try {
      return await originalFetch.apply(globalThis, args)
    } catch (error) {
      let shouldRetry = false
      // not ideal, but there is no error code for that
      if (error.message === 'fetch failed' && attempt < NUM_RETRIES) {
        // on this error we try again
        shouldRetry = true
      }

      if (shouldRetry) {
        // leave some trace in logs what's happening
        console.error('[fetch-retry] fetch thrown, retrying...', {
          args,
          attempt,
          errorMsg: error.message,
        })

        const currentBackoff = backoff
        await new Promise((resolve) => {
          setTimeout(resolve, currentBackoff)
        })
        backoff *= 2
        continue
      }

      throw error
    }
  }
}
