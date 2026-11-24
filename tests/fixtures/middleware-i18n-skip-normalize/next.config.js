module.exports = {
  output: 'standalone',
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  i18n: {
    locales: ['en', 'fr', 'nl', 'es'],
    defaultLocale: 'en',
  },
  skipMiddlewareUrlNormalize: true,
  // `trailing-slash` test variant
  trailingSlash: process.env.TRAILING_SLASH === 'true',
  generateBuildId: () => 'build-id',
  experimental: {
    clientRouterFilter: true,
    clientRouterFilterRedirects: true,
    nodeMiddleware: true,
  },
  redirects() {
    return [
      {
        source: '/to-new',
        destination: '/dynamic/new',
        permanent: false,
      },
    ]
  },
  outputFileTracingRoot: __dirname,
}
