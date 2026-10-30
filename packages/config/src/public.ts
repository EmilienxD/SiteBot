import { isEnvSourced } from './env.js'
import { childPath } from './errors.js'
import { isToolEnabled } from './schema/tools.js'
import type { AuthMode } from './schema/security.js'
import type { Mode } from './schema/config.js'
import type { Ui } from './schema/ui.js'
import type { ResolvedConfig } from './validate.js'

/**
 * Exactly what `GET /api/chat/config` serves — docs/03-protocol.md §6.
 *
 * `name` is optional because it is the one public field that can be sourced
 * from the environment, and env-sourced values never leave the server.
 */
export interface PublicConfig {
  name?: string
  mode: Mode
  ui: Ui
  capabilities: PublicCapabilities
  pending?: PublicPendingRun
  version?: string
}

export interface PublicPendingRun {
  runId: string
  approval: {
    approvalId: string
    toolName: string
    toolCallId: string
    title?: string
    description?: string
    input?: unknown
    risk: 'low' | 'medium' | 'high'
  }
}

export interface PublicCapabilities {
  streaming: boolean
  fileUpload: boolean
  /**
   * The authoritative allowlist. The widget refuses a `data-client-tool-call`
   * for any name not in this list (docs/05-tools.md §5 rule 1).
   */
  clientTools: string[]
  /**
   * Tool name → the client implementation it runs, when they differ: a tool
   * named `highlight_section` with `executor: { type: client, id: highlight }`
   * runs an application-registered handler. Names absent here run under their own name.
   */
  clientToolIds?: Record<string, string>
  authMode: AuthMode
}

export interface PublicConfigOptions {
  /** Package version reported to the widget. */
  version?: string
}

/**
 * Reduce a resolved config to the subset that may reach the browser.
 *
 * Two independent mechanisms, which is the point — docs/08-security.md §2:
 *
 *  1. An explicit allowlist. Only the fields named below are copied, so a new
 *     server-side config section is private by default rather than by review.
 *  2. Mechanical removal of anything sourced from `${env.*}`, applied *after*
 *     the allowlist. A secret that somehow reaches an allowlisted field is
 *     still dropped, without anyone having to notice it could get there.
 */
export function toPublicConfig(
  config: ResolvedConfig,
  options: PublicConfigOptions = {},
): PublicConfig {
  const envPaths = config.$meta?.envPaths ?? []

  const clientTools: string[] = []
  const clientToolIds: Record<string, string> = {}
  for (const entry of config.tools) {
    if (!isToolEnabled(entry.enabled)) continue
    if (entry.executor?.type === 'client') {
      clientTools.push(entry.name)
      if (entry.executor.id !== entry.name) clientToolIds[entry.name] = entry.executor.id
    }
  }

  const publicConfig: PublicConfig = {
    mode: config.mode,
    ui: stripEnvSourced(config.ui, 'ui', envPaths) as Ui,
    capabilities: {
      streaming: config.ui.behaviour.streaming,
      fileUpload: config.ui.behaviour.allowFileUpload,
      clientTools,
      ...(Object.keys(clientToolIds).length > 0 ? { clientToolIds } : {}),
      authMode: config.security.auth.mode,
    },
  }

  if (!isEnvSourced('name', envPaths)) publicConfig.name = config.name
  if (options.version !== undefined) publicConfig.version = options.version

  return publicConfig
}

/**
 * Deep-copy `node`, omitting every path that came from the environment.
 *
 * Omitting rather than masking is deliberate: a `"***"` in the panel title
 * looks like a rendering bug and invites someone to "fix" it by whitelisting
 * the field. An absent key falls through to the widget's built-in default.
 */
function stripEnvSourced(node: unknown, path: string, envPaths: readonly string[]): unknown {
  if (isEnvSourced(path, envPaths)) return undefined

  if (Array.isArray(node)) {
    return node
      .map((item, index) => stripEnvSourced(item, childPath(path, index), envPaths))
      .filter((item) => item !== undefined)
  }

  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      const child = stripEnvSourced(value, childPath(path, key), envPaths)
      if (child !== undefined) out[key] = child
    }
    return out
  }

  return node
}
