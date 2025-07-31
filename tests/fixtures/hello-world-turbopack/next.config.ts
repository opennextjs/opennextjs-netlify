/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  // https://github.com/vercel/next.js/issues/81864
  outputFileTracingRoot: __dirname,
  turbopack: {
    root: __dirname,
  },
}

module.exports = nextConfig
