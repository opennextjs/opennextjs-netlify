/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  generateBuildId: () => 'build-id',
}

module.exports = nextConfig
