/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    nodeMiddleware: true,
  },
  webpack: (config) => {
    // disable minification for easier inspection of produced build output
    config.optimization.minimize = false
    return config
  },
}

module.exports = nextConfig
