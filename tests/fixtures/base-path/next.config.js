/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  basePath: '/base/path',
  eslint: {
    ignoreDuringBuilds: true,
  },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
