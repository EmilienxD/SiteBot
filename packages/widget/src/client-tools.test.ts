import { describe, expect, it } from 'vitest'
import { runClientTool } from './client-tools.js'
import { defaultConfig } from './defaults.js'
import { createSessionId } from './storage.js'

describe('client tools', () => {
  it('rejects names outside the server allowlist', async () => {
    await expect(runClientTool('read_element', { selector: 'body' }, { config: defaultConfig, pageContext: async () => null, registered: new Map() })).rejects.toThrow(/not allowed/)
  })

  it('never reads denied selectors and never submits forms', async () => {
    document.body.innerHTML = '<form id="checkout"><input name="password" type="password"><input name="email"></form>'
    const config = structuredClone(defaultConfig)
    config.capabilities.clientTools = ['fill_form', 'read_element']
    const result = await runClientTool('fill_form', { selector: '#checkout', fields: { email: 'a@example.com' } }, { config, pageContext: async () => null, registered: new Map() })
    expect(result).toEqual({ filled: true })
    expect((document.querySelector('[name=email]') as HTMLInputElement).value).toBe('a@example.com')
    await expect(runClientTool('read_element', { selector: 'input[name=password]' }, { config, pageContext: async () => null, registered: new Map() })).resolves.toEqual({ error: 'selector_denied' })
  })

  it('allows navigation only to server routes or explicit patterns', async () => {
    const config = structuredClone(defaultConfig)
    config.capabilities.clientTools = ['navigate']
    config.capabilities.routes = ['/pricing']
    config.ui.behaviour.navigateAllowlist = ['/docs/*']
    await expect(runClientTool('navigate', { path: '/pricing' }, { config, pageContext: async () => null, registered: new Map() })).resolves.toMatchObject({ navigated: true })
    await expect(runClientTool('navigate', { path: '/admin' }, { config, pageContext: async () => null, registered: new Map() })).rejects.toThrow(/not allowed/)
  })

  it('generates server-valid UUID session ids', () => {
    expect(createSessionId()).toMatch(/^[0-9a-f-]{36}$/i)
  })
})
