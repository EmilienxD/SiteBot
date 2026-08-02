import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { DevConsole } from './dev-console'
import './globals.css'

export const metadata: Metadata = {
  title: 'Northwind Logistics',
  description: 'B2B freight forwarding and customs brokerage for mid-market importers.',
}

/**
 * The demo site's shell.
 *
 * Phase 4 adds the widget's `<script>` tag here and deletes `<DevConsole/>`.
 * Until then the console is how a browser can exercise the endpoint, and the
 * page content below is what page-context extraction will be measured against.
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
        <DevConsole />
      </body>
    </html>
  )
}
