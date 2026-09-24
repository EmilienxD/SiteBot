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

  it('outlines forms with their select and radio options but never their values', async () => {
    document.body.innerHTML = `<main><p>${'Long text. '.repeat(600)}</p>
      <form id="wholesale-form">
        <input name="email" type="email" value="me@example.com">
        <input name="token" type="hidden" value="s3cret">
        <select name="volume">
          <option value="">Choose…</option>
          <option value="5-20">5–20 kg</option>
          <option value="50+">Over 50 kg</option>
        </select>
        <label><input type="radio" name="roast" value="light"> Light</label>
        <label><input type="radio" name="roast" value="dark"> Dark</label>
      </form>
      <form class="redacted"><select name="card"><option value="x">X</option></select></form>
    </main>`
    const ui = structuredClone(defaultConfig.ui)
    ui.pageContext.redactSelectors = ['.redacted']
    const context = await extractPageContext(ui)
    // Kept whole even though the page text overflows the extract budget.
    expect(context?.extract).toContain(
      '[Form #wholesale-form: email (email), volume (select: 5-20 "5–20 kg" | 50+ "Over 50 kg"), roast (radio: light "Light" | dark "Dark")]',
    )
    expect(context?.extract?.length).toBeLessThanOrEqual(4000)
    expect(context?.extract).not.toContain('me@example.com')
    expect(context?.extract).not.toContain('token')
    expect(context?.extract).not.toContain('card')
  })

  it("leaves the widget's own element out of the extract (docs/03 §10 step 3)", async () => {
    document.body.innerHTML =
      '<main><p>Page text.</p><site-chat><span>Chat transcript text</span></site-chat></main>'
    const extract = (await extractPageContext(defaultConfig.ui))?.extract ?? ''
    expect(extract).toContain('Page text.')
    expect(extract).not.toContain('Chat transcript text')
  })

  it('truncates at 4000 characters on a sentence boundary, and says so (docs/03 §10)', async () => {
    document.body.innerHTML = `<main><p>${'A short sentence here. '.repeat(400)}</p></main>`
    const extract = (await extractPageContext(defaultConfig.ui))?.extract ?? ''
    expect(extract.length).toBeLessThanOrEqual(4000)
    expect(extract.endsWith('here.…[truncated]')).toBe(true)
  })

  it('uses extractHash without resending unchanged text', async () => {
    const first = await extractPageContext(defaultConfig.ui)
    const second = await extractPageContext(defaultConfig.ui, first?.extractHash)
    expect(second?.extract).toBeUndefined()
    expect(second?.extractHash).toBe(first?.extractHash)
  })
})
