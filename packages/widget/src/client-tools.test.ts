import { describe, expect, it, vi } from 'vitest'
import { runClientTool } from './client-tools.js'
import { defaultConfig } from './defaults.js'
import { createSessionId } from './storage.js'

describe('application client handlers', () => {
  it('rejects names outside the server allowlist before invoking handlers', async () => {
    const handler = vi.fn()
    await expect(
      runClientTool(
        'lookup',
        {},
        { config: defaultConfig, registered: new Map([['lookup', handler]]) },
      ),
    ).rejects.toThrow('not allowed')
    expect(handler).not.toHaveBeenCalled()
  })
  it.each([
    'navigate',
    'fill_form',
    'read_element',
    'get_page_context',
    'open_url',
    'highlight',
    'copy_to_clipboard',
  ])('has no fallback for %s', async (name) => {
    const config = structuredClone(defaultConfig)
    config.capabilities.clientTools = [name]
    await expect(runClientTool(name, {}, { config, registered: new Map() })).rejects.toThrow(
      'No client tool handler',
    )
  })
  it('invokes only the explicit application id handler and bounds its result', async () => {
    const config = structuredClone(defaultConfig)
    config.capabilities.clientTools = ['lookup']
    config.capabilities.clientToolIds = { lookup: 'application_lookup' }
    const handler = vi.fn(async (input) => input)
    const other = vi.fn()
    const options = {
      config,
      registered: new Map([
        ['application_lookup', handler],
        ['lookup', other],
      ]),
    }
    expect(await runClientTool('lookup', { found: true }, options)).toEqual({ found: true })
    expect(other).not.toHaveBeenCalled()
    expect(await runClientTool('lookup', 'a'.repeat(17000), options)).toEqual({
      error: 'result_too_large',
    })
  })
  it('propagates application failures', async () => {
    const config = structuredClone(defaultConfig)
    config.capabilities.clientTools = ['lookup']
    await expect(
      runClientTool(
        'lookup',
        {},
        {
          config,
          registered: new Map([
            [
              'lookup',
              () => {
                throw new Error('app failure')
              },
            ],
          ]),
        },
      ),
    ).rejects.toThrow('app failure')
  })
  it('uses crypto for session identifiers', () => {
    expect(createSessionId()).toMatch(/^[0-9a-f-]{36}$/)
  })
})
