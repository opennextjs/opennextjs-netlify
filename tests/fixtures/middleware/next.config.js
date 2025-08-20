/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: process.env.NEXT_RUNTIME_MIDDLEWARE === 'nodejs' ? '.next-node-middleware' : '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    nodeMiddleware: true,
  },
  webpack: (config) => {
    // this is a trigger to generate multiple `.next/server/middleware-[hash].js` files instead of
    // single `.next/server/middleware.js` file
    // this doesn't seem to actually work with Node Middleware - it result in next build failures
    // config.optimization.splitChunks.maxSize = 100_000

    return config
  },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
