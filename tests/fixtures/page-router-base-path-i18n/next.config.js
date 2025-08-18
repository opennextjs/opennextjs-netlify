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
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
