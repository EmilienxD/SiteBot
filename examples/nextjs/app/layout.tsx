import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { SiteBot } from './sitebot'
import './globals.css'

export const metadata: Metadata = {
  title: 'Lumen Bikes',
  description: 'E-bikes sold, fitted and serviced in Utrecht.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <nav>
            <a className="brand" href="/">
              Lumen Bikes
            </a>
            <a href="/bikes">Bikes</a>
            <a href="/service">Service</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer>Lumen Bikes is fictional — this is the SiteBot Next.js example.</footer>
        <SiteBot />
      </body>
    </html>
  )
}
