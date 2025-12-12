const { satisfies } = require('semver')

// https://github.com/vercel/next.js/pull/84280
const pprConfigHardDeprecated = satisfies(
  require('next/package.json').version,
  '>=15.6.0-canary.58',
  {
    includePrerelease: true,
  },
)

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: pprConfigHardDeprecated
    ? {
        cacheComponents: true,
      }
    : {
        ppr: true,
      },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
