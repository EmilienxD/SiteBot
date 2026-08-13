import { render } from 'preact'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from './markdown.js'

afterEach(() => (document.body.innerHTML = ''))

function html(text: string): HTMLElement {
  const root = document.createElement('div')
  document.body.append(root)
  render(<Markdown text={text} />, root)
  return root
}

describe('Markdown', () => {
  it('renders the supported whitelist and fixes bold closing markers', () => {
    const root = html(
      '# Title\n\n**bold** and *italic* with `code`\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```js\nconst a=1\n```',
    )
    expect(root.querySelector('h1')?.textContent).toBe('Title')
    expect(root.querySelector('strong')?.textContent).toBe('bold')
    expect(root.textContent).not.toContain('*bold')
    expect(root.querySelector('em')?.textContent).toBe('italic')
    expect(root.querySelector('p code')?.textContent).toBe('code')
    expect([...root.querySelectorAll('ul li')].map((node) => node.textContent)).toEqual([
      'one',
      'two',
    ])
    expect([...root.querySelectorAll('ol li')].map((node) => node.textContent)).toEqual([
      'first',
      'second',
    ])
    expect(root.querySelector('blockquote')?.textContent).toBe('quoted')
    expect(root.querySelector('pre.markdown-code code')?.textContent).toBe('const a=1')
  })

  it('opens safe links and renders unsafe links as text without raw HTML', () => {
    const root = html('[safe](/docs) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>')
    const link = root.querySelector('a')!
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(root.querySelectorAll('a')).toHaveLength(1)
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('<img src=x')
  })
})
