/**
 * @sitebot/core/node — the Node-only surface.
 *
 * Anything that imports `node:*` belongs here: the stdio MCP transport, the
 * sqlite session store, filesystem-backed knowledge stores. The root entry
 * stays edge-compatible because none of this is reachable from it.
 *
 * Implemented across Phases 2, 5 and 6.
 */

export const NODE_RUNTIME_MARKER = 'node' as const
