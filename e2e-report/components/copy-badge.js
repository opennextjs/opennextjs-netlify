'use client'
import { useEffect, useState } from 'react'
import { CopyIcon } from './icons'
import { badgeSettings } from '@/utils/consts'

export default function CopyBadgeButton() {
  const [host, setHost] = useState('')
  useEffect(() => {
    setHost(window?.location.origin || '')
  }, [])

  const badgeLink = `
<a href="${host}/" target="_blank">
  <img 
    src="${host}/badge"
    width="${badgeSettings.displaySize.width}" 
    height="${badgeSettings.displaySize.height}"
    alt="${badgeSettings.alt}"
  />
</a>`

  return (
    <button
      className="btn btn-xs btn-outline text-white rounded px-0.5"
      onClick={() => {
        navigator.clipboard.writeText(badgeLink)
      }}
    >
      <CopyIcon className="size-4" />
    </button>
  )
}
