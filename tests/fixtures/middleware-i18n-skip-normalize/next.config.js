module.exports = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  i18n: {
    locales: ['en', 'fr', 'nl', 'es'],
    defaultLocale: 'en',
  },
  skipMiddlewareUrlNormalize: true,
  experimental: {
    clientRouterFilter: true,
    clientRouterFilterRedirects: true,
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
