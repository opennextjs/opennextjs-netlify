/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    nodeMiddleware: true,
  },
  serverExternalPackages: ['nanoid'],
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
