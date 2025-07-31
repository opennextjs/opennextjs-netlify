const { join } = require('path')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  transpilePackages: ['@repo/ui'],
  // https://github.com/vercel/next.js/issues/81864
  outputFileTracingRoot: join(__dirname, '..', '...'),
}

module.exports = nextConfig
