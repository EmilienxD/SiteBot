/**
 * The lazy half of the widget — docs/07-widget.md §1:
 *
 *   "The panel's Preact tree is lazy — only the launcher renders until first
 *    open, then the chat chunk is dynamically imported. First paint cost is a
 *    button."
 *
 * Everything expensive hangs off this module: the panel's component tree, the
 * chat controller, and through it the `ai` transport, which is by a wide margin
 * the biggest dependency in the widget.
 *
 * Nothing may import this file statically. `element.tsx` reaches it through a
 * dynamic `import()` — that dynamic edge is the only reason Rollup emits it as
 * a separate chunk, so a stray static import anywhere would silently fold it
 * back into the launcher and blow the initial budget.
 */
export { createController } from './chat.js'
export { Panel } from './panel.js'
