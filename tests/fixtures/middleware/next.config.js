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
  generateBuildId: () => 'build-id',
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
  // turbopack becomes default for builds in Next 16. There is failure when webpack configuration is present
  // without turbopack configuration, so we add a turbopack configuration here to ensure this fixture
  // works with default build bundler for all tested versions
  // see https://github.com/vercel/next.js/blob/ba5a0ca79944b4c8a59d80d677bfedaf0fef33d6/packages/next/src/lib/turbopack-warning.ts#L159-L177
  turbopack: {},
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
