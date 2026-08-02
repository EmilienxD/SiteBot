import { createElement, useEffect, useRef } from 'react'
import type { SiteBotEvent, SiteBotOptions } from '@sitebot/widget'

export interface ChatWidgetProps extends SiteBotOptions {
  publicKey?: string
  className?: string
  onEvent?: (event: SiteBotEvent) => void
}

export const WIDGET_ELEMENT_NAME = 'site-chat'

export function ChatWidget({ className, onEvent, ...options }: ChatWidgetProps) {
  const reference = useRef<HTMLElement>(null)
  useEffect(() => {
    let active = true
    void import('@sitebot/widget').then(({ defineSiteBot }) => {
      if (!active) return
      defineSiteBot(options)
      const element = reference.current as
        | (HTMLElement & { configure?: (value: SiteBotOptions) => void })
        | null
      element?.configure?.({ ...options, onEvent })
    })
    return () => {
      active = false
    }
  }, [onEvent, options.endpoint, options.publicKey, options.autoOpen, options.position, options.theme, options.nonce])
  return createElement(WIDGET_ELEMENT_NAME, { ref: reference, class: className, 'data-endpoint': options.endpoint, 'data-key': options.publicKey })
}
