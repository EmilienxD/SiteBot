/**
 * The launcher's stylesheet and the design tokens — docs/07-widget.md §4.
 *
 * This module is in the initial chunk, so it carries only what the first paint
 * needs: the token block, the host reset and the launcher. Everything the panel
 * uses lives in `panel-styles.ts` and arrives with the lazy chunk.
 *
 * The token values are data rather than a CSS string so that the contrast test
 * (styles.test.ts) reads the same numbers the browser does — "contrast is
 * validated, not assumed" (docs/07 §4) only holds if the two cannot drift.
 */

export const lightTokens = {
  'sb-panel-w': '400px',
  'sb-panel-h': '640px',
  'sb-panel-radius': '16px',
  'sb-offset-x': '24px',
  'sb-offset-y': '24px',
  'sb-gap': '12px',
  'sb-pad': '20px',
  'sb-surface': '#ffffff',
  'sb-surface-raised': '#f4f4f5',
  'sb-border': 'rgba(0,0,0,.08)',
  'sb-shadow': '0 12px 48px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.06)',
  'sb-font': 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
  'sb-text': '#18181b',
  'sb-muted': '#63636b',
  'sb-size-body': '15px',
  'sb-size-title': '16px',
  'sb-size-small': '12px',
  'sb-leading': '1.45',
  'sb-primary': '#4f46e5',
  'sb-on-primary': '#ffffff',
  'sb-bubble-assistant-bg': '#efefef',
  'sb-bubble-assistant-fg': '#18181b',
  'sb-bubble-user-bg': 'var(--sb-primary)',
  'sb-bubble-user-fg': 'var(--sb-on-primary)',
  'sb-bubble-radius': '16px',
  'sb-bubble-pad': '12px 16px',
  'sb-bubble-max-w': '82%',
  'sb-pill-bg': '#ffffff',
  'sb-pill-fg': '#27272a',
  'sb-pill-border': '#71717a',
  'sb-pill-radius': '999px',
  'sb-pill-pad': '9px 16px',
  'sb-input-bg': '#f1f1f2',
  'sb-input-fg': '#18181b',
  'sb-input-radius': '12px',
  'sb-input-pad': '12px 14px',
  'sb-send-size': '32px',
  'sb-launcher-size': '56px',
  'sb-launcher-bg': 'var(--sb-primary)',
  'sb-launcher-fg': 'var(--sb-on-primary)',
  'sb-danger-bg': '#fef2f2',
  'sb-danger-fg': '#991b1b',
  'sb-ease': 'cubic-bezier(.16,1,.3,1)',
  'sb-dur': '240ms',
} as const

export const darkTokens = {
  // A lighter indigo: the light-theme primary is 2.8:1 on the dark surface,
  // under the 3:1 a focus ring needs, while white text on it stays ≥ 4.5:1.
  'sb-primary': '#5e5ce6',
  'sb-surface': '#18181b',
  'sb-surface-raised': '#27272a',
  'sb-text': '#fafafa',
  'sb-muted': '#a1a1aa',
  'sb-bubble-assistant-bg': '#27272a',
  'sb-bubble-assistant-fg': '#fafafa',
  'sb-pill-bg': '#18181b',
  'sb-pill-fg': '#f4f4f5',
  'sb-pill-border': '#71717a',
  'sb-input-bg': '#27272a',
  'sb-input-fg': '#fafafa',
  'sb-border': 'rgba(255,255,255,.1)',
  'sb-shadow': '0 12px 48px rgba(0,0,0,.5)',
  'sb-danger-bg': '#3b1212',
  'sb-danger-fg': '#fecaca',
} as const

function block(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--${name}:${value}`)
    .join(';')
}

const dark = `${block(darkTokens)};color-scheme:dark`

export const styles =
  `:host{all:initial;${block(lightTokens)};font:var(--sb-size-body)/var(--sb-leading) var(--sb-font);color:var(--sb-text);color-scheme:light}` +
  `:host([data-theme=dark]){${dark}}` +
  `@media(prefers-color-scheme:dark){:host(:not([data-theme=light])){${dark}}}` +
  '*{box-sizing:border-box}button,textarea,input{font:inherit;color:inherit}' +
  '.launcher{position:fixed;right:max(var(--sb-offset-x),env(safe-area-inset-right));bottom:max(var(--sb-offset-y),env(safe-area-inset-bottom));width:var(--sb-launcher-size);height:var(--sb-launcher-size);border:0;border-radius:999px;background:var(--sb-launcher-bg);color:var(--sb-launcher-fg);box-shadow:var(--sb-shadow);display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;animation:sb-in var(--sb-dur) var(--sb-ease);transition:transform var(--sb-dur) var(--sb-ease)}' +
  '.launcher:hover{transform:translateY(-1px)}.launcher.pill{width:auto;height:48px;padding:0 20px 0 14px;font-weight:600}' +
  '.launcher.left{right:auto;left:max(var(--sb-offset-x),env(safe-area-inset-left))}.launcher img{width:28px;height:28px;border-radius:50%;object-fit:cover}' +
  '.launcher.open{opacity:0;pointer-events:none;transform:scale(.9)}' +
  '.badge{position:absolute;right:-3px;top:-4px;background:#dc2626;color:#fff;min-width:20px;height:20px;padding:0 5px;border:2px solid #fff;border-radius:999px;font-size:11px;display:grid;place-items:center}' +
  '.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}' +
  ':focus-visible{outline:2px solid var(--sb-primary);outline-offset:2px}' +
  '@keyframes sb-in{from{opacity:0;transform:translateY(8px)}}' +
  '@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}'
