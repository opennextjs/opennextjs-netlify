const { join } = require('path')

/** @type {import('next').NextConfig} */
module.exports = {
  transpilePackages: ['@repo/ui'],
  // https://github.com/vercel/next.js/issues/81864
  outputFileTracingRoot: join(__dirname, '..', '...'),
}
