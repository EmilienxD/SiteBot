import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { SiteBotWidget } from './sitebot-widget'
import './globals.css'

export const metadata: Metadata = {
  title: 'Northwind Logistics',
  description: 'B2B freight forwarding and customs brokerage for mid-market importers.',
}

/**
 * The demo site's shell.
 *
 * The real Phase 4 widget runs against the production-shaped endpoint.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <nav>
            <a className="brand" href="/">
              Northwind Logistics
            </a>
            <a href="/pricing">Pricing</a>
            <a href="/docs">Docs</a>
            <a href="/support">Support</a>
          </nav>
        </header>
        {children}
        <footer className="site">
          <div>
            Northwind Logistics is a fictional company. This site is the SiteBot playground — it
            exists so the assistant has something real to be wrong about.
          </div>
        </footer>
        <SiteBotWidget />
      </body>
    </html>
  )
}
