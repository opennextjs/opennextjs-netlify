/** @type {import('next').NextConfig} */
module.exports = {
  output: 'standalone',
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  i18n:
    process.env.NEXT_I18N === 'false'
      ? undefined
      : {
          // `en-US` to test region locales
          locales: ['en', 'fr', 'en-US'],
          defaultLocale: 'en',
        },
  experimental: {
    nodeMiddleware: true,
  },
  generateBuildId: () => 'build-id',
  outputFileTracingRoot: __dirname,
}
