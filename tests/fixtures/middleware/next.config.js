/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    nodeMiddleware: true,
  },
  webpack: (config) => {
    // this is a trigger to generate multiple `.next/server/middleware-[hash].js` files instead of
    // single `.next/server/middleware.js` file
    if (process.env.SPLIT_CHUNKS) {
      // this doesn't seem to actually work with Node Middleware - it result in next build failures
      // so we only do this for default/Edge Runtime
      config.optimization.splitChunks.maxSize = 100_000
    }

    return config
  },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
