/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    // for next@<14.0.0
    serverActions: true,
  },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
