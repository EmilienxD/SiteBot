import { containsEnvPlaceholder } from './env.js'
import { childPath, didYouMean } from './errors.js'
import type { SiteBotConfig } from './schema/config.js'
import type { BackendEntry } from './schema/backend.js'
import type { BuildTarget, ConfigError, ConfigWarning } from './types.js'

/**
 * The cross-field rules from docs/02-configuration.md §14, plus the three rules
 * stated elsewhere in the spec that are also validation-time
 * ("validation rejects" / "a fatal config error"):
 *
 *   duplicate tool names          docs/05-tools.md §1
 *   mcp stdio on edge             docs/05-tools.md §3 rule 4
 *   `*` as an allowed origin      docs/08-security.md §7
 *
 * Every message here is asserted verbatim by a test. Treat them as API: a
 * developer greps for the sentence they saw in their terminal.
 */

export interface CrossFieldContext {
  target: BuildTarget
  /** Config paths whose value came from `${env.*}`. */
  envPaths: readonly string[]
}

export interface CrossFieldResult {
  errors: ConfigError[]
  warnings: ConfigWarning[]
}

export function checkCrossFields(
  config: SiteBotConfig,
  context: CrossFieldContext,
): CrossFieldResult {
  const errors: ConfigError[] = []
  const warnings: ConfigWarning[] = []

  config.tools.forEach((entry, index) => {
    if (entry.maxCallsPerSession !== undefined && config.storage.type === 'none')
      errors.push({
        path: `tools[${index}].maxCallsPerSession`,
        rule: 'tools/session-limit-needs-storage',
        message: 'Session tool limits require session storage.',
      })
  })

  ruleChatForbidsWritableTools(config, errors)
  ruleAgentForbidsStatelessStorage(config, errors)
  ruleProviderRequirements(config, errors)
  ruleAuthRequiredNeedsJwt(config, errors)
  ruleAuthenticatedToolsNeedAuth(config, errors)
  ruleSuggestionToolsExist(config, errors)
  ruleUiHasNoSecrets(config, errors)

  ruleToolNamesAreUnique(config, errors)
  ruleStdioNotAvailableOnEdge(config, context, errors)
  ruleNoWildcardOrigin(config, errors)
  ruleHttpParamsStayInThePath(config, errors)

  warnUnapprovedWritableTools(config, warnings)
  warnPublicFieldFromEnv(config, context, warnings)

  return { errors, warnings }
}

/**
 * docs/05 §7 rule 5: any non-`readOnly` tool the model can reach without an
 * approval card gets a warning. Approval is opt-in per tool
 * (`requiresApproval`, `agent.approvalRequired`), so a writable tool that is
 * simply never listed is exactly as ungated as one under `approvalPolicy:
 * never` — and far easier to miss.
 */
function warnUnapprovedWritableTools(config: SiteBotConfig, warnings: ConfigWarning[]): void {
  if (config.mode !== 'agent') return
  const never = config.agent.approvalPolicy === 'never'
  config.tools.forEach((entry, index) => {
    if (entry.readOnly || entry.enabled === false) return
    const gated = entry.requiresApproval || config.agent.approvalRequired.includes(entry.name)
    if (gated && !never) return
    const name = `Writable tool "${entry.name}"`
    warnings.push({
      path: `tools[${index}]`,
      message: never
        ? `${name} is reachable without approval because agent.approvalPolicy is "never".`
        : `${name} runs without an approval card: it is not readOnly and not approval-gated.`,
      fix: never
        ? 'Set approvalPolicy to `always` or `once-per-session`, or mark the tool readOnly if it has no side effects.'
        : 'Add `requiresApproval: true` (or list it in agent.approvalRequired), or mark it readOnly if it has no side effects.',
      rule: 'tools/unapproved-writable',
    })
  })
}

// ── 1 ───────────────────────────────────────────────────────────────────────

/**
 * The rule that stops an "it's only a simple chatbot" config from quietly
 * having the power to place orders.
 */
function ruleChatForbiddenNames(config: SiteBotConfig): string[] {
  const offenders: string[] = []
  for (const entry of config.tools) {
    if (entry.readOnly === true) continue
    offenders.push(entry.name)
  }
  return offenders
}

function ruleChatForbidsWritableTools(config: SiteBotConfig, errors: ConfigError[]): void {
  if (config.mode !== 'chat') return
  const offenders = ruleChatForbiddenNames(config)
  if (offenders.length === 0) return

  errors.push({
    path: 'tools',
    message: `mode: chat allows only tools marked readOnly: true. These are not: ${offenders.join(', ')}.`,
    value: offenders,
    expected: 'every tool to declare readOnly: true',
    fix: 'Add `readOnly: true` to each tool that has no side effects, or switch to `mode: agent` and gate the rest with `agent.approvalRequired`.',
    rule: 'cross-field/1',
  })
}

// ── 2 ───────────────────────────────────────────────────────────────────────

function ruleAgentForbidsStatelessStorage(config: SiteBotConfig, errors: ConfigError[]): void {
  if (config.mode !== 'agent' || config.storage.type !== 'none') return

  errors.push({
    path: 'storage.type',
    message: 'mode: agent requires server-side session storage, but storage.type is "none".',
    value: 'none',
    expected: 'memory | sqlite | redis | postgres | custom',
    fix: 'Approval gates and client-tool resume checkpoint the loop into the session store, so agent mode cannot be stateless. Use `sqlite` for a single node or `redis` for multiple replicas.',
    rule: 'cross-field/2',
  })
}

// ── 3 and 4 ─────────────────────────────────────────────────────────────────

function ruleProviderRequirements(config: SiteBotConfig, errors: ConfigError[]): void {
  checkBackendEntry(config.backend, 'backend', errors)
  config.backend.fallback.forEach((entry, index) => {
    checkBackendEntry(entry, `backend.fallback[${index}]`, errors)
  })
}

function checkBackendEntry(entry: BackendEntry, path: string, errors: ConfigError[]): void {
  if (entry.provider === 'openai-compatible' && entry.baseUrl === undefined) {
    errors.push({
      path: `${path}.baseUrl`,
      message: 'provider "openai-compatible" requires a baseUrl.',
      expected: 'the base URL of an OpenAI-compatible endpoint',
      fix: `Set ${path}.baseUrl, for example https://my-gateway.example.com/v1`,
      rule: 'cross-field/3',
    })
  }
  if (entry.provider === 'custom' && entry.module === undefined) {
    errors.push({
      path: `${path}.module`,
      message: 'provider "custom" requires a module path to a LanguageModel factory.',
      expected: 'a module path, optionally with a named export',
      fix: `Set ${path}.module, for example ./providers/my-gateway.ts#factory`,
      rule: 'cross-field/4',
    })
  }
}

// ── 5 ───────────────────────────────────────────────────────────────────────

// ── 6 ───────────────────────────────────────────────────────────────────────

// ── 7 ───────────────────────────────────────────────────────────────────────

function ruleAuthRequiredNeedsJwt(config: SiteBotConfig, errors: ConfigError[]): void {
  if (config.security.auth.mode !== 'required') return
  if (config.security.auth.jwt !== undefined) return

  errors.push({
    path: 'security.auth.jwt',
    message: 'security.auth.mode "required" needs security.auth.jwt to verify tokens with.',
    expected: 'a jwt block with either `secret` or `jwksUrl`',
    fix: 'Add `security.auth.jwt: { secret: ${env.SITEBOT_JWT_SECRET}, issuer: …, audience: … }`, or relax the mode to `optional`.',
    rule: 'cross-field/7',
  })
}

// ── 8 ───────────────────────────────────────────────────────────────────────

function ruleAuthenticatedToolsNeedAuth(config: SiteBotConfig, errors: ConfigError[]): void {
  if (config.security.auth.mode !== 'none') return

  config.tools.forEach((entry, index) => {
    if (entry.scope !== 'authenticated') return
    const label = entry.name
    errors.push({
      path: `tools[${index}].scope`,
      message: `Tool "${label}" has scope: authenticated, but security.auth.mode is "none" — there is no verified identity to check against.`,
      value: 'authenticated',
      expected: 'security.auth.mode to be "optional" or "required"',
      fix: 'Set `security.auth.mode: optional` so a signed-in visitor gets the tool and an anonymous one does not, or drop the scope.',
      rule: 'cross-field/8',
    })
  })
}

// ── 9 ───────────────────────────────────────────────────────────────────────

function ruleSuggestionToolsExist(config: SiteBotConfig, errors: ConfigError[]): void {
  const configured = new Set<string>()
  for (const entry of config.tools) {
    configured.add(entry.name)
  }

  config.ui.messages.suggestions.forEach((suggestion, index) => {
    if (suggestion.action.type !== 'tool') return
    const { tool } = suggestion.action
    if (configured.has(tool)) return

    errors.push({
      path: `ui.messages.suggestions[${index}].action.tool`,
      message: `Suggestion action refers to tool "${tool}", which is not configured.`,
      value: tool,
      expected:
        configured.size > 0
          ? `one of: ${[...configured].join(', ')}`
          : 'the name of a tool declared in `tools`',
      fix: `Add a tool named "${tool}" to \`tools\`, or point the suggestion at an existing one.`,
      suggestion: didYouMean(tool, [...configured]),
      rule: 'cross-field/9',
    })
  })
}

// ── 10 ──────────────────────────────────────────────────────────────────────

function ruleUiHasNoSecrets(config: SiteBotConfig, errors: ConfigError[]): void {
  for (const path of findEnvPlaceholders(config.ui, 'ui')) {
    errors.push({
      path,
      message: 'ui must not contain ${env.*} — the whole block is served to the browser.',
      expected: 'a literal value',
      fix: 'Move the value out of `ui`. If it is genuinely public, inline it; if it is a secret, it does not belong anywhere the widget can read.',
      rule: 'cross-field/10',
    })
  }
}

/** Paths under `node` whose string value still holds a `${env.…}` placeholder. */
function findEnvPlaceholders(node: unknown, path: string): string[] {
  if (typeof node === 'string') {
    return containsEnvPlaceholder(node) ? [path] : []
  }
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => findEnvPlaceholders(item, childPath(path, index)))
  }
  if (typeof node === 'object' && node !== null) {
    return Object.entries(node).flatMap(([key, value]) =>
      findEnvPlaceholders(value, childPath(path, key)),
    )
  }
  return []
}

// ── additional normative rules ──────────────────────────────────────────────

/** docs/05-tools.md §1: duplicate names are a fatal config error. */
function ruleToolNamesAreUnique(config: SiteBotConfig, errors: ConfigError[]): void {
  const seen = new Map<string, number>()
  config.tools.forEach((entry, index) => {
    const first = seen.get(entry.name)
    if (first === undefined) {
      seen.set(entry.name, index)
      return
    }
    errors.push({
      path: `tools[${index}].name`,
      message: `Duplicate tool name "${entry.name}" — already defined at tools[${first}].`,
      value: entry.name,
      expected: 'a unique tool name',
      fix: 'Rename one of them. (Redefining a tool by name is only meaningful across an `extends` boundary, where the TS config intentionally overrides the declarative one.)',
      rule: 'tools/duplicate-name',
    })
  })
}

/** docs/05-tools.md §3 rule 4. */
function ruleStdioNotAvailableOnEdge(
  config: SiteBotConfig,
  context: CrossFieldContext,
  errors: ConfigError[],
): void {
  if (context.target !== 'edge') return

  config.tools.forEach((entry, index) => {
    const server = entry.executor?.type === 'mcp' ? entry.executor.server : undefined
    if (server?.transport !== 'stdio') return

    errors.push({
      path: `tools[${index}].server.transport`,
      message: 'MCP transport "stdio" is not available on the edge runtime.',
      value: 'stdio',
      expected: 'http | sse',
      fix: 'Edge runtimes cannot spawn a child process. Host the MCP server separately and connect over `http`.',
      rule: 'tools/stdio-on-edge',
    })
  })
}

/** docs/08-security.md §7: `*` alone is rejected. */
function ruleNoWildcardOrigin(config: SiteBotConfig, errors: ConfigError[]): void {
  config.security.allowedOrigins.forEach((origin, index) => {
    if (origin.trim() !== '*') return
    errors.push({
      path: `security.allowedOrigins[${index}]`,
      message: '"*" is not an allowed origin — list the origins that may embed the widget.',
      value: origin,
      expected: 'an exact origin, or a single-level wildcard like https://*.acme.com',
      fix: 'Replace it with the origins you actually serve. An empty list already means same-origin only, which is the safe default.',
      rule: 'security/wildcard-origin',
    })
  })
}

/**
 * A model-controlled `{param}` in `text`, ignoring server-verified
 * `{{identity.*}}`-style placeholders. Exported for the runtime guard in core,
 * which applies the same rule to configs that never went through validation.
 */
export function modelParameterIn(text: string): string | undefined {
  return /{([^{}]+)}/.exec(text.replace(/{{[^}]*}}/g, ''))?.[0]
}

/**
 * docs/05 §2 rules 2–3: a model-controlled `{param}` may appear in the URL
 * path, the query and the body — never in the scheme or host, where it would
 * choose the server, nor in a header name or value, where it could inject.
 */
function ruleHttpParamsStayInThePath(config: SiteBotConfig, errors: ConfigError[]): void {
  config.tools.forEach((entry, index) => {
    if (entry.executor?.type !== 'http') return
    const { url, headers } = entry.executor
    // Everything before the path: `scheme://host:port`.
    const origin = /^[^/]*\/\/[^/]*/.exec(url)?.[0] ?? url.split('/')[0] ?? ''
    const inOrigin = modelParameterIn(origin)
    if (inOrigin !== undefined)
      errors.push({
        path: `tools[${index}].executor.url`,
        message: `Tool "${entry.name}" puts the model-controlled ${inOrigin} in the URL's scheme or host.`,
        value: url,
        expected: 'a fixed scheme and host; parameters only in the path, query or body',
        fix: 'Write the host literally. To reach several hosts, define one tool per host, or use allowHosts with a fixed host.',
        rule: 'tools/param-in-host',
      })
    for (const [name, value] of Object.entries(headers)) {
      const inHeader = modelParameterIn(name) ?? modelParameterIn(value)
      if (inHeader === undefined) continue
      errors.push({
        path: `tools[${index}].executor.headers.${name}`,
        message: `Tool "${entry.name}" puts the model-controlled ${inHeader} in a header.`,
        value,
        expected:
          'static text, ${env.*}, or server-verified {{identity.*}} / {{session.*}} / {{page.*}}',
        fix: 'Move the value into the query or body, where it is encoded; a header set by the model can inject.',
        rule: 'tools/param-in-header',
      })
    }
  })
}

// ── warnings ────────────────────────────────────────────────────────────────

/**
 * `name` is the one public field that can legitimately come from the
 * environment — and env-sourced values are stripped from `PublicConfig`
 * mechanically (docs/08-security.md §2), so it would silently vanish from the
 * panel header. Better to say so at load time.
 */
function warnPublicFieldFromEnv(
  _config: SiteBotConfig,
  context: CrossFieldContext,
  warnings: ConfigWarning[],
): void {
  if (!context.envPaths.includes('name')) return
  warnings.push({
    path: 'name',
    message:
      '`name` comes from the environment, so it is excluded from the public config and will not reach the widget.',
    fix: 'Inline the name if it is not a secret; the widget falls back to its built-in title otherwise.',
    rule: 'public/env-sourced-field',
  })
}
