/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  generateBuildId: () => 'build-id',
  // https://github.com/vercel/next.js/issues/81864
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
