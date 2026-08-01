/**
 * @sitebot/server — layer 3.
 *
 * Adapters only. Each one normalises its framework's request into a Web
 * `Request`, calls `engine.handleChat`, and translates the `Response` back.
 * All the logic lives in @sitebot/core; nothing here should be more than thin.
 *
 * Implemented in Phase 3 — see docs/03-protocol.md.
 */

/** Default mount point. Every adapter accepts a `basePath` override. */
export const DEFAULT_BASE_PATH = '/api/chat'

/** The four endpoints, relative to `basePath`. docs/03-protocol.md §1. */
export const ROUTES = {
  chat: '',
  config: '/config',
  feedback: '/feedback',
  health: '/health',
} as const

export type RouteName = keyof typeof ROUTES
