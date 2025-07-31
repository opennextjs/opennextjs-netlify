module.exports = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  i18n: {
    locales: ['en', 'fr'],
    defaultLocale: 'en',
  },
  // https://github.com/vercel/next.js/issues/81864
  outputFileTracingRoot: __dirname,
}
