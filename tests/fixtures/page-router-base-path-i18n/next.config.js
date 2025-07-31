/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  generateBuildId: () => 'build-id',
  basePath: '/base/path',
  i18n: {
    locales: ['en', 'fr', 'de'],
    defaultLocale: 'en',
  },
  // https://github.com/vercel/next.js/issues/81864
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
