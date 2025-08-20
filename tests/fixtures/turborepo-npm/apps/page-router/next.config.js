const { join } = require('node:path')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  transpilePackages: ['@repo/ui'],
  outputFileTracingRoot: join(__dirname, '..', '..'),
}

module.exports = nextConfig
