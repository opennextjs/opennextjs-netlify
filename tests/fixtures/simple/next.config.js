/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    outputFileTracingIncludes: {
      '/': ['public/**'],
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        pathname: '/?(photo)-**-**',
      },
      {
        hostname: '*.pixabay.com',
      },
    ],
    domains: ['images.pexels.com'],
  },
  async rewrites() {
    return [
      {
        source: '/rewrite-no-basepath',
        destination: 'https://example.vercel.sh',
        basePath: false,
      },
      {
        source: '/config-rewrite/source',
        destination: '/config-rewrite/dest',
      },
    ]
  },
  async redirects() {
    return [
      {
        source: '/config-redirect/source',
        destination: '/config-redirect/dest',
        permanent: true,
      },
    ]
  },
  outputFileTracingRoot: __dirname,
}

module.exports = nextConfig
