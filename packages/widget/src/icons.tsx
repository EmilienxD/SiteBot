/**
 * Inline SVG glyphs. Every one is decorative (`aria-hidden`): the control that
 * wraps it carries the accessible name (docs/07 §8).
 *
 * The launcher's three glyphs live here, in the initial chunk; the panel's
 * glyphs are in `panel.tsx` so they arrive with the lazy chunk.
 */
export const LAUNCHER_GLYPHS = {
  sparkle: 'M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z',
  chat: 'M4 5h16v11H8l-4 3V5Z',
  question: 'M12 17h.01M9.5 9a2.5 2.5 0 1 1 4.3 1.8c-.9.8-1.8 1.1-1.8 2.7',
} as const

export function Icon({ d, size = 20, filled }: { d: string; size?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  )
}
