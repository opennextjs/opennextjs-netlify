/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  experimental: {
    cacheLife: {
      testCacheLife: {
        stale: 0,
        revalidate: 365 * 60 * 60 * 24, // 1 year
        expire: 5, // 5 seconds to test expiration
      },
    },
  },
}

module.exports = nextConfig
