# @sitebot/react

A React component for the [SiteBot](https://github.com/EmilienxD/SiteBot) chat widget.

```bash
npm i @sitebot/react
```

```tsx
'use client'
import { ChatWidget } from '@sitebot/react'

export function SiteBot() {
  return <ChatWidget endpoint="/api/chat" />
}
```

Render it once, e.g. in your root layout. Props mirror the script tag's attributes: `endpoint`,
`publicKey`, `position`, `theme`, `autoOpen` and `nonce`, plus `className` and `onEvent` for widget
events. The widget itself is [`@sitebot/widget`](https://www.npmjs.com/package/@sitebot/widget).
