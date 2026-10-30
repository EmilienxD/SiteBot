/**
 * @sitebot/cli - layer 4. Nothing imports this package.
 *
 * The complete command implementations land in Phase 9. Phase 8 owns the
 * production security audit because deployments need it before the rest of
 * the CLI exists.
 */

import { isEnvSourced, type ResolvedConfig } from '@sitebot/config'
import { validateBudgetPricing } from '@sitebot/core'

export interface CommandSpec {
  readonly name: string
  readonly summary: string
}

export interface ProductionCheck {
  label: string
  ok: boolean
  detail: string
  manual?: boolean
}

export interface DoctorReport {
  checks: ProductionCheck[]
  ok: boolean
}

export interface ProductionDoctorOptions {
  gitignore?: string | null
}

export function productionDoctor(
  config: ResolvedConfig,
  options: ProductionDoctorOptions = {},
): DoctorReport {
  const checks: ProductionCheck[] = []
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail })
  const manual = (label: string, detail: string) =>
    checks.push({ label, ok: true, detail, manual: true })

  add(
    'allowedOrigins',
    config.security.allowedOrigins.length > 0 && !config.security.allowedOrigins.includes('*'),
    'Explicit origins are configured and no wildcard-only origin is present.',
  )

  const hasPrivateTool = config.tools.some(
    (tool) => tool.scope === 'authenticated' || !tool.readOnly || tool.executor?.type === 'http',
  )
  add(
    'auth',
    !hasPrivateTool || config.security.auth.mode === 'required',
    'auth.mode is required when configured tools can touch user data.',
  )
  add(
    'approvals',
    config.tools
      .filter((tool) => !tool.readOnly)
      .every((tool) => tool.requiresApproval || config.agent.approvalRequired.includes(tool.name)),
    'Every writable local or MCP tool requires approval.',
  )
  add(
    'http allowHosts',
    config.tools.every(
      (tool) => tool.executor?.type !== 'http' || (tool.executor.allowHosts?.length ?? 0) > 0,
    ),
    'HTTP tools have explicit host allowlists.',
  )
  const budgetAlerting =
    config.security.budget.maxUsdPerDay !== undefined &&
    config.telemetry.enabled &&
    config.telemetry.events.webhook !== undefined &&
    config.telemetry.events.include.includes('budget_exceeded')
  add(
    'budget alerting',
    budgetAlerting,
    'A daily USD budget and budget_exceeded webhook alert are configured.',
  )
  const pricingErrors = validateBudgetPricing(config)
  add(
    'budget pricing',
    pricingErrors.length === 0,
    pricingErrors.length === 0
      ? 'All models used with a daily USD cap have pricing.'
      : pricingErrors.map((error) => `${error.message} ${error.fix}`).join(' '),
  )
  add(
    'rateLimit store',
    config.security.rateLimit.store === 'redis',
    'Redis backs production rate limits so multiple replicas share one sliding window.',
  )
  add(
    'session storage',
    !['memory', 'none'].includes(config.storage.type),
    'Production session state is persisted outside one process.',
  )
  add(
    'trustProxy',
    config.security.trustProxy !== false,
    'A trusted proxy hop count is configured; verify it matches the deployed topology.',
  )

  const inlineSecrets = findInlineSecrets(config)
  const envIgnored = gitignoreCoversEnv(options.gitignore)
  add(
    'secrets',
    inlineSecrets.length === 0 && envIgnored,
    inlineSecrets.length > 0
      ? `Literal-looking secrets found at: ${inlineSecrets.join(', ')}.`
      : envIgnored
        ? 'Secret-looking values are env-sourced and .env files are gitignored.'
        : '.env and .env.local are not both covered by .gitignore.',
  )

  add(
    'sensitive routes',
    sensitiveRoutesExcluded(config),
    'Declared admin, account, and internal routes are excluded from page context.',
  )
  add(
    'privacy footer',
    config.ui.footer !== undefined && config.ui.footer.text.trim().length > 0,
    'ui.footer carries a visible privacy or recording notice.',
  )
  manual('widget integrity', 'Confirm the widget is self-hosted or pinned with an SRI hash.')

  return { checks, ok: checks.every((check) => check.manual === true || check.ok) }
}

export function findInlineSecrets(config: ResolvedConfig): string[] {
  const findings: string[] = []
  const envPaths = config.$meta.envPaths

  const visit = (value: unknown, path: string): void => {
    if (path === '$meta' || isEnvSourced(path, envPaths)) return
    if (typeof value === 'string') {
      if (path !== 'security.publicKey' && looksLikeSecret(value, path)) findings.push(path)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`))
      return
    }
    if (typeof value !== 'object' || value === null) return
    for (const [key, entry] of Object.entries(value)) {
      visit(entry, path === '' ? key : `${path}.${key}`)
    }
  }

  visit(config, '')
  return findings
}

function looksLikeSecret(value: string, path: string): boolean {
  if (value.includes('{{')) return false
  if (/(?:^|[^a-z0-9])(?:sk|pk)[-_][a-z0-9_-]{8,}/i.test(value)) return true
  try {
    const url = new URL(value)
    if (url.password !== '') return true
  } catch {
    // Most secrets are not URLs.
  }
  const sensitivePath =
    /(?:^|\.)(?:apiKey|secret|token|password|authorization)(?:$|\.)|\.headers(?:\.|$)|\.env\./i.test(
      path,
    )
  return sensitivePath && value.length >= 24 && !/\s/.test(value)
}

function gitignoreCoversEnv(gitignore: string | null | undefined): boolean {
  if (gitignore === undefined || gitignore === null) return false
  const patterns = gitignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => line.replace(/^\//, '').replace(/^\*\*\//, ''))
  return ['.env', '.env.local'].every((file) =>
    patterns.some((pattern) => globMatches(file, pattern)),
  )
}

function sensitiveRoutesExcluded(config: ResolvedConfig): boolean {
  const sensitive = config.siteContext.routes
    .map((route) => route.path)
    .filter((path) => /(?:^|\/)(?:admin|account|internal)(?:\/|$)/i.test(path))
  if (sensitive.length === 0) return true

  return sensitive.every((path) =>
    config.ui.pageContext.excludePaths.some((pattern) => globMatches(path, pattern)),
  )
}

function globMatches(value: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${pattern}$`).test(value)
}

/** The six commands, in the order `sitebot --help` prints them. docs/01 section 2. */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'init', summary: 'Scaffold config, route handler and script tag, interactively' },
  { name: 'validate', summary: 'Validate the config and print it resolved, with secrets masked' },
  { name: 'dev', summary: 'Local dev server and playground page, with config hot-reload' },
  { name: 'serve', summary: 'Production sidecar server (topology T2)' },
  { name: 'doctor', summary: 'Diagnose env vars, provider reachability, store health and CORS' },
]
