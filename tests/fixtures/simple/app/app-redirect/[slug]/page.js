import { redirect } from 'next/navigation'

const Page = async () => {
  return redirect(`/app-redirect/dest`)
}

export const generateStaticParams = async () => {
  return [{ slug: 'prerendered' }]
}

export default Page
