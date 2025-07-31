/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    ppr: true,
  },
  // https://github.com/vercel/next.js/issues/81864
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
