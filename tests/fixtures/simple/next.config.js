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
    ]
  },
}

module.exports = nextConfig
