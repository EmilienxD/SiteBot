import { describe, expect, it } from 'vitest'
import { DEFAULT_Z_INDEX, ELEMENT_NAME, storageKey } from './index.js'

describe('@sitebot/widget', () => {
  it('runs in a DOM environment', () => {
    expect(typeof document).toBe('object')
  })

  it('names the custom element site-chat', () => {
    expect(ELEMENT_NAME).toBe('site-chat')
    expect(ELEMENT_NAME).toContain('-') // custom elements require a hyphen
  })

  it('stacks below the max z-index so host modals can still be raised above', () => {
    expect(DEFAULT_Z_INDEX).toBeLessThan(2147483647)
  })

  it('namespaces storage keys by public key (docs/07 §9)', () => {
    expect(storageKey('pk_live_a1b2c3', 'sessionId')).toBe('sitebot:pk_live_a1b2c3:sessionId')
  })
})
