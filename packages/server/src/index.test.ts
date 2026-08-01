import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE_PATH, ROUTES } from './index.js'

describe('@sitebot/server', () => {
  it('mounts at /api/chat by default', () => {
    expect(DEFAULT_BASE_PATH).toBe('/api/chat')
  })

  it('declares the four endpoints of docs/03 §1', () => {
    expect(Object.keys(ROUTES)).toEqual(['chat', 'config', 'feedback', 'health'])
  })
})
