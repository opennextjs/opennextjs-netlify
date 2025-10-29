// see next.config for details about 'next-og-alias'
import { ImageResponse } from 'next-og-alias'

export async function GET() {
  return new ImageResponse(<div>hi</div>, {
    width: 1200,
    height: 630,
  })
}

export const dynamic = 'force-dynamic'
