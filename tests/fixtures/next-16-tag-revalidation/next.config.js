/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  experimental: {
    cacheLife: {
      testCacheLife: {
        stale: 0,
        // revalidate has to be lower than expire to pass config validation.
        // We only use this profile to test on-demand revalidation which only uses `expire` value
        revalidate: 1,
        // 5 seconds to test expiration
        expire: 5,
      },
    },
  },
}

module.exports = nextConfig
