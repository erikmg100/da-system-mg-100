import './globals.css'

export const metadata = {
  title: 'Speech Assistant',
  description: 'AI-powered speech assistant',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
