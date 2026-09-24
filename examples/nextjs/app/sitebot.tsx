'use client'

import { ChatWidget } from '@sitebot/react'

// The widget, talking to the route in app/api/chat on the same origin.
export function SiteBot() {
  return <ChatWidget endpoint="/api/chat" />
}
