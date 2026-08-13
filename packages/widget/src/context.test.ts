import { beforeEach, describe, expect, it } from 'vitest'
import { extractPageContext } from './context.js'
import { defaultConfig } from './defaults.js'

describe('extractPageContext', () => {
  beforeEach(() => {
    document.head.innerHTML =
      '<title>Docs</title><meta name="description" content="Page description"><meta property="og:type" content="article">'
    document.body.innerHTML =
      '<main><h1>Heading</h1><p>First sentence.</p><ul><li>One</li></ul><script>secret()</script><div class="strip">remove</div></main>'
  })

  it('preserves structure, strips configured nodes, selection and custom context', async () => {
    const ui = structuredClone(defaultConfig.ui)
    ui.extract.strip = ['.strip']
    getSelection()?.selectAllChildren(document.querySelector('p')!)
    const context = await extractPageContext(ui, undefined, { plan: 'pro' })
    expect(context?.extract).toContain('# Heading')
    expect(context?.extract).toContain('• One')
    expect(context?.extract).not.toContain('secret')
    expect(context?.extract).not.toContain('remove')
    expect(context?.selection).toContain('First sentence')
    expect(context?.custom).toEqual({ plan: 'pro' })
    expect(context?.meta).toEqual({ 'og:type': 'article' })
  })

  it('uses extractHash without resending unchanged text', async () => {
    const first = await extractPageContext(defaultConfig.ui)
    const second = await extractPageContext(defaultConfig.ui, first?.extractHash)
    expect(second?.extract).toBeUndefined()
    expect(second?.extractHash).toBe(first?.extractHash)
  })
})
