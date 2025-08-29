/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    nodeMiddleware: true,
  },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
