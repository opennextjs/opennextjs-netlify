import { ImageResponse } from 'next/og'
import testData from '@/utils/data'
import { badgeSettings } from '@/utils/consts'

export const dynamic = 'force-static'

const labelStyle = {
  background: 'linear-gradient(#2e51ed, #316bf4)',
  color: 'white',
}

const bgStyles = {
  ok: { background: 'linear-gradient(to bottom, #22c55e, #86efac)' },
  warning: { background: 'linear-gradient(to bottom, #ca8a04, #fef08a)' },
  error: { background: 'linear-gradient(to bottom, #dc2626, #f87171)', color: 'white' },
}

// Generate an SVG badge with test status and target Next.js version
export async function GET() {
  const valueStyle =
    bgStyles[testData.failed === 0 ? 'ok' : testData.unknownFailuresCount > 0 ? 'error' : 'warning']

  const badge = (
    <Badge
      label={badgeSettings.label}
      labelStyle={labelStyle}
      value={testData.nextVersion}
      valueStyle={valueStyle}
    />
  )
  return new ImageResponse(badge, {
    ...badgeSettings.imageSize,
  })
}

function Badge({ label, labelStyle, value, valueStyle }) {
  return (
    <div tw="flex items-center w-full h-full text-[26px] rounded-md overflow-hidden bg-transparent">
      <span tw="items-center h-full p-3.5" style={labelStyle}>
        {label}
      </span>
      <span tw="items-center h-full flex-grow justify-center" style={valueStyle}>
        {value}
      </span>
    </div>
  )
}
