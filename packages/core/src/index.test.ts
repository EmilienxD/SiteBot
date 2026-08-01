import { describe, expect, it } from 'vitest'
import { EXECUTOR_KINDS, MODES } from './index.js'

describe('@sitebot/core', () => {
  it('exposes exactly the two policy modes', () => {
    expect(MODES).toEqual(['chat', 'agent'])
  })

  it('exposes the five executor kinds (docs/00 D8)', () => {
    expect(EXECUTOR_KINDS).toHaveLength(5)
  })
})
