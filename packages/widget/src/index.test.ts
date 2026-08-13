import { describe, expect, it } from 'vitest'
import { DEFAULT_Z_INDEX, ELEMENT_NAME, SiteBot, defineSiteBot, storageKey } from './index.js'

describe('@sitebot/widget', () => {
  it('runs in a DOM environment', () => {
    expect(typeof document).toBe('object')
  })
  it('names the custom element site-chat', () => {
    expect(ELEMENT_NAME).toBe('site-chat')
    expect(ELEMENT_NAME).toContain('-')
  })
  it('stacks below the maximum z-index', () => {
    expect(DEFAULT_Z_INDEX).toBeLessThan(2147483647)
  })
  it('namespaces storage keys by public key', () => {
    expect(storageKey('pk_live_a1b2c3', 'sessionId')).toBe('sitebot:pk_live_a1b2c3:sessionId')
  })
  it('defines one closed-shadow element and keeps API calls safe', () => {
    document.body.innerHTML = ''
    const element = defineSiteBot({ endpoint: '/api/chat', publicKey: 'pk_test' })
    expect(element?.shadowRoot).toBeNull()
    expect(document.querySelectorAll(ELEMENT_NAME)).toHaveLength(1)
    expect(() => SiteBot.open()).not.toThrow()
  })
})
