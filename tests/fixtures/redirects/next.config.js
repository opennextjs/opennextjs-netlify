/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  async redirects() {
    return [
      {
        source: '/simple',
        destination: '/dest',
        permanent: true,
      },
      {
        source: '/with-placeholder/:slug',
        destination: '/dest/:slug',
        permanent: true,
      },
      {
        source: '/with-splat/:path*',
        destination: '/dest/:path',
        permanent: true,
      },
      {
        source: '/with-regex/:slug(\\d{1,})',
        destination: '/dest-regex/:slug',
        permanent: true,
      },
      {
        source: '/with-has',
        destination: '/dest-has',
        permanent: true,
        has: [{ type: 'header', key: 'x-foo', value: 'bar' }],
      },
      {
        source: '/with-missing',
        destination: '/dest-missing',
        permanent: true,
        missing: [{ type: 'header', key: 'x-bar' }],
      },
    ]
  },
}

module.exports = nextConfig
