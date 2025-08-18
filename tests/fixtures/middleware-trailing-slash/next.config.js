/** @type {import('next').NextConfig} */
const nextConfig = {
  trailingSlash: true,
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
