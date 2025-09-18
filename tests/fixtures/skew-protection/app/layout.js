export const metadata = {
  title: 'Simple Next App',
  description: 'Description for Simple Next App',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
