export { middleware } from './middleware-shared'

export const config = {
  runtime: 'nodejs',
  matcher: [
    {
      source: '/foo',
      missing: [{ type: 'header', key: 'x-custom-header', value: 'custom-value' }],
    },
    {
      source: '/hello',
    },
    {
      source: '/nl/about',
      locale: false,
    },
  ],
}
