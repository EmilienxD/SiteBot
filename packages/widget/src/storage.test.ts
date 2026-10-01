import { afterEach, expect, it, vi } from 'vitest'
import { readValue, removeValue, writeValue } from './storage.js'

afterEach(() => vi.unstubAllGlobals())

it('does not resurrect a cleared session from the memory fallback', () => {
  writeValue('storage-test-cleared', 'old-session', 'session')
  sessionStorage.clear()
  expect(readValue('storage-test-cleared', 'session')).toBeNull()
  removeValue('storage-test-cleared')
})

it('keeps the two scopes separate and remains usable when browser storage is unavailable', () => {
  const blocked = {
    setItem() {
      throw new Error('Storage is blocked')
    },
    removeItem() {
      throw new Error('Storage is blocked')
    },
  }
  vi.stubGlobal('localStorage', blocked)
  vi.stubGlobal('sessionStorage', blocked)
  writeValue('storage-test-blocked', 'browser-session', 'local')
  expect(readValue('storage-test-blocked', 'session')).toBeNull()
  writeValue('storage-test-blocked', 'tab-session', 'session')
  expect(readValue('storage-test-blocked', 'local')).toBe('browser-session')
  expect(readValue('storage-test-blocked', 'session')).toBe('tab-session')
  expect(() => removeValue('storage-test-blocked')).not.toThrow()
  expect(readValue('storage-test-blocked', 'local')).toBeNull()
  expect(readValue('storage-test-blocked', 'session')).toBeNull()
})
