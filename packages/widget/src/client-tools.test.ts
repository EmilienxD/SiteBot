import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runClientTool } from './client-tools.js'
import { defaultConfig } from './defaults.js'
import { createSessionId } from './storage.js'

describe('client tools', () => {
  it('rejects names outside the server allowlist', async () => {
    await expect(
      runClientTool(
        'read_element',
        { selector: 'body' },
        { config: defaultConfig, pageContext: async () => null, registered: new Map() },
      ),
    ).rejects.toThrow(/not allowed/)
  })

  it('never reads denied selectors and never submits forms', async () => {
    document.body.innerHTML =
      '<form id="checkout"><input name="password" type="password"><input name="email"></form>'
    const submit = vi.fn()
    document.querySelector('#checkout')?.addEventListener('submit', submit)
    const config = structuredClone(defaultConfig)
    config.capabilities.clientTools = ['fill_form', 'read_element']
    const result = await runClientTool(
      'fill_form',
      { selector: '#checkout', fields: { email: 'a@example.com' } },
      { config, pageContext: async () => null, registered: new Map() },
    )
    expect(result).toEqual({ filled: true, filledFields: ['email'], rejected: [], missing: [] })
    expect((document.querySelector('[name=email]') as HTMLInputElement).value).toBe('a@example.com')
    expect(submit).not.toHaveBeenCalled()
    await expect(
      runClientTool(
        'read_element',
        { selector: 'input[name=password]' },
        { config, pageContext: async () => null, registered: new Map() },
      ),
    ).resolves.toEqual({ error: 'selector_denied' })
  })

  describe('fill_form verification', () => {
    const run = (fields: Record<string, unknown>) => {
      const config = structuredClone(defaultConfig)
      config.capabilities.clientTools = ['fill_form']
      return runClientTool(
        'fill_form',
        { selector: '#inquiry', fields },
        { config, pageContext: async () => null, registered: new Map() },
      )
    }
    const volume = () => document.querySelector('[name=volume]') as HTMLSelectElement

    beforeEach(() => {
      document.body.innerHTML = `<form id="inquiry">
        <input name="email">
        <input name="qty" type="number">
        <input name="price" type="hidden" value="10">
        <select name="volume">
          <option value="">Choose…</option>
          <option value="5-20">5–20 kg</option>
          <option value="50+">Over 50 kg</option>
        </select>
      </form>`
    })

    it('rejects a select value that is not an option and lists the valid ones', async () => {
      await expect(run({ email: 'a@example.com', volume: '30 kg' })).resolves.toEqual({
        filled: false,
        filledFields: ['email'],
        rejected: [
          {
            field: 'volume',
            reason: 'invalid_option',
            options: [
              { value: '5-20', label: '5–20 kg' },
              { value: '50+', label: 'Over 50 kg' },
            ],
          },
        ],
        missing: [],
      })
      expect(volume().value).toBe('')
    })

    it('reports fields that do not exist in the form', async () => {
      await expect(run({ email: 'a@example.com', phone: '555' })).resolves.toMatchObject({
        filled: false,
        filledFields: ['email'],
        missing: ['phone'],
      })
    })

    it('accepts an option by its visible label, loosely matched', async () => {
      await expect(run({ volume: '5–20 kg' })).resolves.toMatchObject({ filled: true })
      expect(volume().value).toBe('5-20')
      await expect(run({ volume: 'over 50kg' })).resolves.toMatchObject({ filled: true })
      expect(volume().value).toBe('50+')
    })

    it('rejects malformed typed values and never writes hidden fields', async () => {
      await expect(run({ qty: 'lots', price: '0' })).resolves.toMatchObject({
        filled: false,
        rejected: [
          { field: 'qty', reason: 'invalid_value' },
          { field: 'price', reason: 'unsupported' },
        ],
      })
      expect((document.querySelector('[name=price]') as HTMLInputElement).value).toBe('10')
    })
  })

  it('allows navigation only to server routes or explicit patterns', async () => {
    const config = structuredClone(defaultConfig)
    config.capabilities.clientTools = ['navigate']
    config.capabilities.routes = ['/pricing']
    config.ui.behaviour.navigateAllowlist = ['/docs/*']
    const navigate = vi.fn()
    await expect(
      runClientTool(
        'navigate',
        { path: '/pricing' },
        { config, pageContext: async () => null, registered: new Map(), navigate },
      ),
    ).resolves.toMatchObject({ navigated: true })
    // A real navigation (deferred by the controller), not history.pushState.
    expect(navigate).toHaveBeenCalledWith('/pricing')
    await expect(
      runClientTool(
        'navigate',
        { path: '/admin' },
        { config, pageContext: async () => null, registered: new Map() },
      ),
    ).rejects.toThrow(/not allowed/)
  })

  it('runs the implementation named by the executor id, allowlisted by tool name', async () => {
    document.body.innerHTML = '<section id="plans">Plans</section>'
    const target = document.getElementById('plans')!
    target.scrollIntoView = vi.fn()
    const config = structuredClone(defaultConfig)
    config.capabilities.clientTools = ['highlight_section', 'get_cart']
    config.capabilities.clientToolIds = { highlight_section: 'highlight', get_cart: 'read_cart' }
    const options = { config, pageContext: async () => null, registered: new Map() }
    await expect(
      runClientTool('highlight_section', { selector: '#plans' }, options),
    ).resolves.toEqual({
      found: true,
    })
    expect(target.scrollIntoView).toHaveBeenCalled()
    // A registered handler is found under either its tool name or its id.
    options.registered.set('read_cart', () => ({ items: 3 }))
    await expect(runClientTool('get_cart', {}, options)).resolves.toEqual({ items: 3 })
    // The id never widens the allowlist.
    await expect(runClientTool('highlight', { selector: '#plans' }, options)).rejects.toThrow(
      /not allowed/,
    )
  })

  it('generates server-valid UUID session ids', () => {
    expect(createSessionId()).toMatch(/^[0-9a-f-]{36}$/i)
  })
})
