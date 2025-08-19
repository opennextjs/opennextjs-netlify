const INFINITE_CACHE = 0xfffffffe

const ONE_YEAR = 365 * 24 * 60 * 60

/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    useCache: true,
    cacheLife: {
      '5seconds': {
        stale: 5,
        revalidate: 5,
        expire: INFINITE_CACHE,
      },
      '10seconds': {
        stale: 10,
        revalidate: 10,
        expire: INFINITE_CACHE,
      },
      '1year': {
        stale: ONE_YEAR,
        revalidate: ONE_YEAR,
        expire: INFINITE_CACHE,
      },
    },
  },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
