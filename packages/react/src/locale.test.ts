import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import type { SiteBotOptions } from '@sitebot/widget'

const state = vi.hoisted(() => ({
  configure: vi.fn(),
  define: vi.fn(),
  effects: [] as Array<{ run: () => unknown; dependencies: unknown[] }>,
}))
vi.mock('@sitebot/widget', () => ({ defineSiteBot: state.define }))
vi.mock('react', async (original) => {
  const react = await original<typeof React>()
  return {
    ...react,
    useRef: () => ({ current: { configure: state.configure } }),
    useEffect: (run: () => unknown, dependencies: unknown[]) => {
      state.effects.push({ run, dependencies })
    },
  }
})
import { ChatWidget } from './index.js'

beforeEach(() => {
  state.effects.length = 0
  state.configure.mockClear()
  state.define.mockClear()
})
describe('React locale integration', () => {
  it('passes locale to the custom element and configures it again when the locale prop changes', async () => {
    const first = ChatWidget({ endpoint: '/api/chat', locale: 'en' })
    expect(first.props['data-locale']).toBe('en')
    state.effects[0]!.run()
    await vi.waitFor(() =>
      expect(state.configure).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' })),
    )
    const second = ChatWidget({ endpoint: '/api/chat', locale: 'fr-CA' })
    expect(second.props['data-locale']).toBe('fr-CA')
    expect(state.effects[1]!.dependencies).not.toEqual(state.effects[0]!.dependencies)
    state.effects[1]!.run()
    await vi.waitFor(() =>
      expect(state.configure).toHaveBeenLastCalledWith(
        expect.objectContaining({ locale: 'fr-CA' }),
      ),
    )
    const last = state.configure.mock.calls.at(-1)?.[0] as SiteBotOptions
    expect(last.endpoint).toBe('/api/chat')
  })
})
