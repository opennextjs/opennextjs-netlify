/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    nodeMiddleware: true,
  },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
