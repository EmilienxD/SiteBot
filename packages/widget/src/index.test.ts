import { describe, expect, it } from 'vitest'
import {
  DEFAULT_Z_INDEX,
  ELEMENT_NAME,
  SiteBot,
  defineSiteBot,
  scriptOptions,
  storageKey,
} from './index.js'

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
  it('reads its options from the script tag, for a cross-origin sidecar', () => {
    const script = document.createElement('script')
    script.dataset.endpoint = 'https://chat.acme.com/api/chat'
    script.dataset.key = 'pk_live_a1b2c3'
    script.dataset.position = 'bottom-left'
    script.dataset.theme = 'dark'
    script.dataset.autoOpen = 'true'
    script.nonce = 'n0nce'
    expect(scriptOptions(script)).toEqual({
      endpoint: 'https://chat.acme.com/api/chat',
      publicKey: 'pk_live_a1b2c3',
      position: 'bottom-left',
      theme: 'dark',
      autoOpen: true,
      nonce: 'n0nce',
    })
  })
  it('ignores script attributes it does not recognise', () => {
    const script = document.createElement('script')
    script.dataset.position = 'top-center'
    script.dataset.theme = 'neon'
    expect(scriptOptions(script)).toEqual({})
    expect(scriptOptions(null)).toEqual({})
  })
  it('defines one closed-shadow element and keeps API calls safe', () => {
    document.body.innerHTML = ''
    const element = defineSiteBot({ endpoint: '/api/chat', publicKey: 'pk_test' })
    expect(element?.shadowRoot).toBeNull()
    expect(document.querySelectorAll(ELEMENT_NAME)).toHaveLength(1)
    expect(() => SiteBot.open()).not.toThrow()
  })
})
