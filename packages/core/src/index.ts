/**
 * @sitebot/core — layer 2. The engine.
 *
 * No HTTP framework dependency, and no `node:*` imports in this entry — it must
 * build for Cloudflare Workers, Vercel Edge and Deno. Node-only pieces (stdio
 * MCP transport, fs-backed stores) live behind `@sitebot/core/node`.
 *
 * Implemented across Phases 2, 5 and 6 — see docs/04-providers-and-engine.md.
 */

export const ENGINE_PROTOCOL_VERSION = 'v1' as const

/** The two policy modes. One engine; `mode` is the only switch. docs/02 §7. */
export const MODES = ['chat', 'agent'] as const
export type Mode = (typeof MODES)[number]

/** Tool executor kinds. docs/00-overview.md D8, docs/05-tools.md. */
export const EXECUTOR_KINDS = ['http', 'mcp', 'module', 'builtin', 'client'] as const
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number]
