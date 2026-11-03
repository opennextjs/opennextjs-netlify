const { satisfies } = require('semver')

const nextVersion = require('next/package.json').version

// https://github.com/vercel/next.js/pull/84280
const pprConfigHardDeprecated = satisfies(nextVersion, '>=15.6.0-canary.58', {
  includePrerelease: true,
})

// https://github.com/vercel/next.js/pull/85035
const cacheComponentsIsTopLevel = satisfies(nextVersion, '>=16.0.0-canary.14', {
  includePrerelease: true,
})

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  ...(cacheComponentsIsTopLevel
    ? { cacheComponents: true }
    : pprConfigHardDeprecated
      ? { experimental: { cacheComponents: true } }
      : { experimental: { ppr: true } }),
  ...(process.env.PARTIAL_PREFETCHING ? { partialPrefetching: true } : {}),
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
