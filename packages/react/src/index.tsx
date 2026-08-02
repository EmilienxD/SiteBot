import { createElement, useEffect, useRef } from 'react'
import { defineSiteBot, type SiteBotEvent, type SiteBotOptions } from '@sitebot/widget'

export interface ChatWidgetProps extends SiteBotOptions {
  publicKey?: string
  className?: string
  onEvent?: (event: SiteBotEvent) => void
}

export const WIDGET_ELEMENT_NAME = 'site-chat'

export function ChatWidget({ className, onEvent, ...options }: ChatWidgetProps) {
  const reference = useRef<HTMLElement>(null)
  useEffect(() => {
    defineSiteBot(options)
    const element = reference.current as (HTMLElement & { configure?: (value: SiteBotOptions) => void }) | null
    element?.configure?.({ ...options, onEvent })
  }, [onEvent, options.endpoint, options.publicKey, options.autoOpen, options.position, options.theme, options.nonce])
  return createElement(WIDGET_ELEMENT_NAME, { ref: reference, class: className, 'data-endpoint': options.endpoint, 'data-key': options.publicKey })
}
