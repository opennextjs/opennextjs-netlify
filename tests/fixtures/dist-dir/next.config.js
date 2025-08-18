/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: 'cool/output',
  eslint: {
    ignoreDuringBuilds: true,
  },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
