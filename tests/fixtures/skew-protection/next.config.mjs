import { remoteImage, variant } from './variant-config.mjs'

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    // for next@<14.0.0
    serverActions: true,
    // for next@<14.1.4
    useDeploymentId: true,
    // Optionally, use with Server Actions
    useDeploymentIdServerActions: true,
  },
  outputFileTracingRoot: import.meta.dirname,

  // for next@<15.1.0
  webpack(config, { webpack }) {
    config.plugins.push(
      new webpack.DefinePlugin({
        // double JSON.stringify is intentional here - this is to keep results same as when using `compile.define`
        'process.env.SKEW_VARIANT': JSON.stringify(JSON.stringify(variant)),
      }),
    )
    return config
  },

  compiler: {
    // this is same as above webpack config, but this will apply to turbopack builds as well
    // so just future proofing it here
    define: {
      'process.env.SKEW_VARIANT': JSON.stringify(variant),
    },
  },

  redirects() {
    return [
      {
        source: '/next-config/redirect',
        destination: `/next-config/redirect-${variant.toLowerCase()}`,
        permanent: false,
      },
    ]
  },
  rewrites() {
    return [
      {
        source: '/next-config/rewrite',
        destination: `/next-config/rewrite-${variant.toLowerCase()}`,
      },
    ]
  },
}

export default nextConfig
