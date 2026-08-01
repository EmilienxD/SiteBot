import { describe, expect, it } from 'vitest'
import { WIDGET_ELEMENT_NAME } from './index.js'

describe('@sitebot/react', () => {
  it('wraps the same custom element the script tag defines', () => {
    expect(WIDGET_ELEMENT_NAME).toBe('site-chat')
  })
})
