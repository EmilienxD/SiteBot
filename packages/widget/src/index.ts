/**
 * @sitebot/widget — layer 3, browser.
 *
 * Defines the `<site-chat>` custom element and exposes `window.SiteBot`.
 * Everything renders inside a closed shadow root so neither the host page's CSS
 * nor its JS can reach the UI. May import *types* from @sitebot/config, and
 * nothing else from the workspace.
 *
 * Implemented in Phase 4 — see docs/07-widget.md.
 */

/** The custom element tag. Double-inclusion of the script must be a no-op. */
export const ELEMENT_NAME = 'site-chat'

/** Default stacking order. Configurable via `ui.zIndex`. docs/07 §2. */
export const DEFAULT_Z_INDEX = 2147483000

/**
 * Storage keys are namespaced by public key so two deployments on one domain
 * cannot collide. docs/07-widget.md §9.
 */
export function storageKey(publicKey: string, name: string): string {
  return `sitebot:${publicKey}:${name}`
}
