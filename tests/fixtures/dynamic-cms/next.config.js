/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  i18n: {
    locales: ['en', 'fr'],
    defaultLocale: 'en',
  },
  generateBuildId: () => 'build-id',
}

module.exports = nextConfig
