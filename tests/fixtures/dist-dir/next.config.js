/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: 'cool/output',
  eslint: {
    ignoreDuringBuilds: true,
  },
  // https://github.com/vercel/next.js/issues/81864
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
