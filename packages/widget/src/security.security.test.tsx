import { render } from 'preact'
import { describe, expect, it } from 'vitest'
import { Markdown } from './markdown.js'

describe('markdown XSS safety', () => {
  it('escapes HTML and refuses javascript links', () => {
    const root = document.createElement('div')
    render(
      <Markdown
        text={'<script>alert(1)</script> [click](javascript:alert(1)) <img onerror=alert(1)>'}
      />,
      root,
    )
    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('a')).toBeNull()
    expect(root.textContent).toContain('<script>alert(1)</script>')
  })
})
