const { platform } = require('process')
const fsPromises = require('fs/promises')
const { satisfies } = require('semver')

// Next.js uses `fs.promises.copyFile` to copy files from `.next`to the `.next/standalone` directory
// It tries copying the same file twice in parallel. Unix is fine with that, but Windows fails
// with "Resource busy or locked", failing the build.
// We work around this by memoizing the copy operation, so that the second copy is a no-op.
// Tracked in TODO: report to Next.js folks
if (platform === 'win32') {
  const copies = new Map()

  const originalCopy = fsPromises.copyFile
  fsPromises.copyFile = (src, dest, mode) => {
    const key = `${dest}:${src}`
    const existingCopy = copies.get(key)
    if (existingCopy) return existingCopy

    const copy = originalCopy(src, dest, mode)
    copies.set(key, copy)
    return copy
  }
}

/** @type {import('next').NextConfig} */
module.exports = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  outputFileTracingRoot: __dirname,
  // there is no single way to use `next/og` or `@vercel/og` depending on Next.js version
  //  - next@<14 doesn't have 'next/og' export
  //  - next turbopack builds doesn't work with `@vercel/og`
  // so this adds `next-og-alias` alias depending on next version for both webpack and turbopack
  // so we can test this in all the versions
  webpack: (config) => {
    const hasNextOg = !satisfies(require('next/package.json').version, '<14.0.0', {
      includePrerelease: true,
    })

    if (!hasNextOg) {
      config.resolve.alias['next-og-alias$'] = '@vercel/og'
    } else {
      config.resolve.alias['next-og-alias$'] = 'next/og'
    }

    return config
  },
  turbopack: {
    resolveAlias: {
      'next-og-alias': 'next/og',
    },
  },
}
