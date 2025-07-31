module.exports = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  i18n: {
    locales: ['en', 'fr', 'nl', 'es'],
    defaultLocale: 'en',
  },
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
  // https://github.com/vercel/next.js/issues/81864
  outputFileTracingRoot: __dirname,
}
