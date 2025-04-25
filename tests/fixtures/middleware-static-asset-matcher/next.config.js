/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    // this is a trigger to generate multiple `.next/server/middleware-[hash].js` files instead of
    // single `.next/server/middleware.js` file
    config.optimization.splitChunks.maxSize = 100_000

    return config
  },
}

module.exports = nextConfig
