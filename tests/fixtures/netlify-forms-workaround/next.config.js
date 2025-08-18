/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  generateBuildId: () => 'build-id',
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
