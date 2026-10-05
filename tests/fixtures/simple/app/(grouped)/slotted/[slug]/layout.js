export const dynamicParams = false

export const generateStaticParams = async () => {
  return [{ slug: 'prerendered' }]
}

export default function Layout({ children, extra }) {
  return (
    <>
      {children}
      {extra}
    </>
  )
}
