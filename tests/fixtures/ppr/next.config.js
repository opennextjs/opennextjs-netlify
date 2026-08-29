const { satisfies } = require('semver')

const nextVersion = require('next/package.json').version
const isAtLeast = (version) => satisfies(nextVersion, `>=${version}`, { includePrerelease: true })

// https://github.com/vercel/next.js/pull/84280
const pprConfigHardDeprecated = isAtLeast('15.6.0-canary.58')

// https://github.com/vercel/next.js/pull/85035 moved the flag out of `experimental`. Setting
// it in the old place is silently ignored, so the placement has to follow the version.
const cacheComponentsIsTopLevel = isAtLeast('16.0.0-canary.14')

// https://github.com/vercel/next.js/pull/94448
// `export const prefetch = 'partial'` only produces a runtime prefetch payload when cached
// navigations are enabled.
const supportsCachedNavigations = isAtLeast('16.2.0-canary.83')

const experimental = {}
if (!pprConfigHardDeprecated) {
  experimental.ppr = true
} else if (!cacheComponentsIsTopLevel) {
  experimental.cacheComponents = true
}
if (supportsCachedNavigations) {
  experimental.cachedNavigations = true
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  ...(cacheComponentsIsTopLevel ? { cacheComponents: true } : {}),
  experimental,
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
