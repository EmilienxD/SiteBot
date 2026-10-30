/* global document, HTMLFormElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement */
import { SiteBot } from '/sitebot.js'

// Consumer-owned handlers. SiteBot supplies no browser action fallback.
SiteBot.registerTool('highlight_section', ({ selector }) => {
  const id =
    typeof selector === 'string' && /^#[a-z0-9-]+$/i.test(selector) ? selector.slice(1) : ''
  const target = document.getElementById(id)
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    target.style.outline = '3px solid #2f5d50'
    setTimeout(() => {
      target.style.outline = ''
    }, 1800)
  }
  return { found: Boolean(target) }
})

SiteBot.registerTool('fill_wholesale_form', ({ selector, fields }) => {
  const form = document.getElementById('wholesale-form')
  if (selector !== '#wholesale-form' || !(form instanceof HTMLFormElement)) return { filled: false }
  const rejected = []
  // This application permits only these public fields. It never submits the form.
  for (const name of ['business', 'email', 'message', 'volume']) {
    if (typeof fields?.[name] !== 'string') continue
    const field = form.elements.namedItem(name)
    if (
      !(
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
      ) ||
      field.disabled
    )
      continue
    let value = fields[name]
    if (field instanceof HTMLSelectElement) {
      const normalize = (text) =>
        text
          .replace(/\s/g, '')
          .replace(/[\u2010-\u2015]/g, '-')
          .toLowerCase()
      const option = [...field.options].find(
        (option) => option.value === value || normalize(option.label) === normalize(value),
      )
      if (!option) {
        rejected.push({ field: name, reason: 'invalid_option' })
        continue
      }
      value = option.value
    }
    field.value = value
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return { filled: rejected.length === 0, rejected }
})
