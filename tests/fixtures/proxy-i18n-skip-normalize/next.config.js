module.exports = {
  output: 'standalone',
  distDir: '.next',
  generateBuildId: () => 'build-id',
  i18n: {
    locales: ['en', 'fr', 'nl', 'es'],
    defaultLocale: 'en',
  },
  skipProxyUrlNormalize: true,
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
