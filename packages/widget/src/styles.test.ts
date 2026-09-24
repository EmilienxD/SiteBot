import { describe, expect, it } from 'vitest'
import { readableOn, relativeLuminance } from './element.js'
import { panelStyles } from './panel-styles.js'
import { darkTokens, lightTokens, styles } from './styles.js'

/**
 * docs/07 §4: "Contrast is validated, not assumed. … every foreground/background
 * token pair meets WCAG AA (4.5:1 for body, 3:1 for large text and UI borders)
 * in both themes." The pairs are read from the same token tables the
 * stylesheet is generated from, so the check cannot drift from what ships.
 */

type Tokens = Record<string, string>

function resolve(tokens: Tokens, name: string): string {
  const value = tokens[name]
  if (value === undefined) throw new Error(`unknown token ${name}`)
  const reference = /^var\(--([\w-]+)\)$/.exec(value)
  return reference ? resolve(tokens, reference[1]!) : value
}

function ratio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  if (a === undefined || b === undefined)
    throw new Error(`not a hex colour: ${foreground} / ${background}`)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const TEXT_PAIRS: Array<[string, string]> = [
  ['sb-text', 'sb-surface'],
  ['sb-muted', 'sb-surface'],
  ['sb-bubble-assistant-fg', 'sb-bubble-assistant-bg'],
  ['sb-bubble-user-fg', 'sb-bubble-user-bg'],
  ['sb-pill-fg', 'sb-pill-bg'],
  ['sb-input-fg', 'sb-input-bg'],
  ['sb-muted', 'sb-input-bg'],
  ['sb-on-primary', 'sb-primary'],
  ['sb-launcher-fg', 'sb-launcher-bg'],
  ['sb-danger-fg', 'sb-danger-bg'],
]
const UI_PAIRS: Array<[string, string]> = [
  ['sb-pill-border', 'sb-surface'],
  ['sb-primary', 'sb-surface'],
]

describe.each([
  ['light', lightTokens as Tokens],
  ['dark', { ...lightTokens, ...darkTokens } as Tokens],
])('%s theme contrast (WCAG AA)', (_theme, tokens) => {
  it.each(TEXT_PAIRS)('%s on %s ≥ 4.5:1', (foreground, background) => {
    expect(ratio(resolve(tokens, foreground), resolve(tokens, background))).toBeGreaterThanOrEqual(
      4.5,
    )
  })
  it.each(UI_PAIRS)('%s against %s ≥ 3:1', (foreground, background) => {
    expect(ratio(resolve(tokens, foreground), resolve(tokens, background))).toBeGreaterThanOrEqual(
      3,
    )
  })
})

describe('custom primary colours', () => {
  it.each(['#ffeb3b', '#1d4ed8', '#22c55e', '#000000', '#fff', '#e11d48'])(
    '--sb-on-primary computed for %s reads at ≥ 4.5:1 or the best available',
    (primary) => {
      const on = readableOn(primary)
      const other = on === '#000' ? '#fff' : '#000'
      expect(ratio(on, primary)).toBeGreaterThanOrEqual(ratio(other, primary))
    },
  )
})

describe('stylesheet', () => {
  it('declares every token on :host and the dark block in both selectors', () => {
    for (const name of Object.keys(lightTokens)) expect(styles).toContain(`--${name}:`)
    expect(styles).toContain(':host([data-theme=dark])')
    expect(styles).toContain('@media(prefers-color-scheme:dark){:host(:not([data-theme=light]))')
  })

  it('references only declared tokens', () => {
    const declared = new Set(Object.keys(lightTokens).map((name) => `--${name}`))
    // --sb-vh is set at runtime from visualViewport (docs/07 §6).
    declared.add('--sb-vh')
    const used = new Set(
      [...(styles + panelStyles).matchAll(/var\((--sb-[\w-]+)/g)].map((m) => m[1]),
    )
    for (const name of used) expect(declared, name).toContain(name)
  })

  it('honours reduced motion and never removes a focus indicator', () => {
    expect(styles).toContain('prefers-reduced-motion:reduce')
    const css = styles + panelStyles
    const removed = [
      ...css.matchAll(/([^{}]+):focus(?:-visible)?\{[^}]*outline:\s*(?:none|0)/g),
    ].map((match) => match[1]!.trim())
    // The composer's textarea is the one exception: its field draws the ring.
    expect(removed).toEqual(['.composer textarea'])
    expect(css).toMatch(/\.composer:focus-within\{box-shadow:0 0 0 2px var\(--sb-primary\)/)
  })
})
