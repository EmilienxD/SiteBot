/**
 * @sitebot/react — layer 3, browser.
 *
 * A thin `<ChatWidget />` for React sites that want the widget in their tree
 * rather than as a global script tag. It wraps the same custom element; it does
 * not fork the UI.
 *
 * Implemented in Phase 4 — see docs/07-widget.md §1.
 */

/** Props accepted by `<ChatWidget />`. The element does the actual work. */
export interface ChatWidgetProps {
  /** Where the route handler is mounted. Default `/api/chat`. */
  endpoint?: string
  /** The deployment's public key, `pk_live_…`. */
  publicKey: string
  /** Open the panel on mount. */
  autoOpen?: boolean
}

export const WIDGET_ELEMENT_NAME = 'site-chat'
