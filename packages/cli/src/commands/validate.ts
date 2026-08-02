/**
 * `sitebot validate` — print exactly what the engine will run.
 *
 * docs/02-configuration.md §14: "prints the fully resolved config with every
 * secret replaced by `***` and every default made explicit, so the developer
 * sees exactly what the engine will run." Both halves matter. Defaults made
 * explicit is what turns "why is it rate limiting me?" into a one-line answer,
 * and masking is what makes the output safe to paste into an issue.
 *
 * Masking is driven by `$meta.envPaths` rather than by key name. A value that
 * came from `${env.*}` is a secret because of where it came from, not because
 * it happened to be called `apiKey` — the same mechanical rule `toPublicConfig`
 * uses (docs/08-security.md §2). Key-name heuristics are layered on top for the
 * developer who pasted a literal, but they are the backstop, not the rule.
 */

import { isEnvSourced, type ResolvedConfig } from '@sitebot/config'
import { lintTools } from '@sitebot/core'
import type { FlagSpecs } from '../args.js'
import type { Ui } from '../terminal.js'
import { loadForCommand, reportConfigError, type CommandContext, type CommandResult } from './context.js'

export const VALIDATE_FLAGS: FlagSpecs = {
  json: { type: 'boolean', summary: 'Print the resolved config as JSON.' },
  'show-secrets': {
    type: 'boolean',
    summary: 'Do not mask secret values. For local debugging only.',
  },
  quiet: { type: 'boolean', summary: 'Only print problems.', short: 'q' },
}

export const MASK = '***'

export async function runValidate(context: CommandContext): Promise<CommandResult> {
  const { ui, flags } = context

  let loaded
  try {
    loaded = await loadForCommand(context)
  } catch (error) {
    return { exitCode: reportConfigError(ui, error) }
  }

  const { config, warnings } = loaded
  const masked = maskConfig(config, flags['show-secrets'] === true)
  const findings = [
    ...warnings.map((warning) => ({
      severity: 'warning' as const,
      path: warning.path,
      message: warning.message,
      fix: warning.fix,
    })),
    ...lintTools(config).map((finding) => ({
      severity: finding.severity,
      path: finding.path,
      message: `${finding.message} [${finding.rule}]`,
      fix: undefined,
    })),
    ...contrastFindings(config),
  ]

  if (flags['json'] === true) {
    ui.line(JSON.stringify(masked, null, 2))
    return { exitCode: 0 }
  }

  const source = config.$meta.sourcePath ?? '(inline object)'
  ui.success(`${source} is valid.`)

  if (flags['quiet'] !== true) {
    if (config.$meta.extendsChain.length > 0) {
      ui.line()
      ui.detail('extends', config.$meta.extendsChain.join(' → '))
    }
    ui.heading('Resolved config')
    for (const line of renderYaml(masked)) ui.line(line)
  }

  if (findings.length > 0) {
    ui.heading(`${findings.length} lint ${findings.length === 1 ? 'finding' : 'findings'}`)
    for (const finding of findings) {
      const render = finding.severity === 'warning' ? ui.warn.bind(ui) : ui.info.bind(ui)
      render(`${ui.style(finding.path, 'bold')} — ${finding.message}`)
      if (finding.fix !== undefined) ui.step(finding.fix)
    }
  }

  // Findings are advisory by definition — a config that fails validation threw
  // above. Exiting non-zero here would make `sitebot validate` unusable as a CI
  // gate for the thing it actually proves.
  return { exitCode: 0 }
}

/**
 * The resolved config with secrets replaced and `$meta` dropped.
 *
 * `$meta` is machinery, not configuration, and printing absolute paths from the
 * developer's machine in something meant to be pasted into an issue is exactly
 * the kind of small leak this command exists to prevent.
 */
export function maskConfig(config: ResolvedConfig, showSecrets = false): Record<string, unknown> {
  const envPaths = config.$meta.envPaths

  const visit = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (showSecrets) return value
      return isEnvSourced(path, envPaths) || isSecretPath(path) ? MASK : value
    }
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, `${path}[${index}]`))
    if (typeof value === 'function') return '[function]'
    if (typeof value !== 'object' || value === null) return value

    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = visit(entry, path === '' ? key : `${path}.${key}`)
    }
    return out
  }

  const { $meta: _meta, ...rest } = config as ResolvedConfig & Record<string, unknown>
  return visit(rest, '') as Record<string, unknown>
}

/**
 * Paths whose value is a secret regardless of where it came from.
 *
 * `security.publicKey` is deliberately absent: it identifies a deployment and
 * grants nothing (docs/02 §12), and masking it would hide the one field a
 * developer needs to compare against their script tag.
 */
function isSecretPath(path: string): boolean {
  if (path === 'security.publicKey') return false
  if (/(?:^|\.)(apiKey|secret|token|password)$/i.test(path)) return true
  if (/\.headers\.(authorization|x-api-key)$/i.test(path)) return true
  // A store or queue URL usually carries credentials in its userinfo.
  return /^(storage|security\.rateLimit|knowledge\.store)\.url$/.test(path)
}

// ── contrast ────────────────────────────────────────────────────────────────

interface Finding {
  severity: 'warning' | 'info'
  path: string
  message: string
  fix: string | undefined
}

/**
 * docs/07-widget.md §4: a custom `--sb-primary` gets its `onPrimary` computed by
 * luminance unless one was set by hand, and `sitebot validate` warns on a
 * failing hand-set pair. The widget cannot warn — by the time it runs, the
 * developer is not looking.
 */
function contrastFindings(config: ResolvedConfig): Finding[] {
  const { primary, onPrimary } = config.ui.theme
  if (primary === undefined || onPrimary === undefined) return []

  const ratio = contrastRatio(primary, onPrimary)
  if (ratio === null || ratio >= 4.5) return []

  return [
    {
      severity: 'warning',
      path: 'ui.theme.onPrimary',
      message: `${onPrimary} on ${primary} is ${ratio.toFixed(2)}:1, below the WCAG AA minimum of 4.5:1.`,
      fix: 'Remove ui.theme.onPrimary and the widget computes a passing value by luminance.',
    },
  ]
}

/** WCAG 2.1 contrast. Returns null for colours this cannot parse. */
export function contrastRatio(a: string, b: string): number | null {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  if (first === null || second === null) return null
  const [light, dark] = first > second ? [first, second] : [second, first]
  return ((light as number) + 0.05) / ((dark as number) + 0.05)
}

function relativeLuminance(color: string): number | null {
  const rgb = parseHex(color)
  if (rgb === null) return null
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function parseHex(color: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  const hex = match?.[1]
  if (hex === undefined) return null
  const full = hex.length === 3 ? [...hex].map((c) => `${c}${c}`).join('') : hex
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

// ── rendering ───────────────────────────────────────────────────────────────

/**
 * YAML, near enough.
 *
 * The resolved config is printed rather than serialised with the `yaml`
 * package because this is display output, not a file: it wants stable key
 * order, empty collections shown as `[]` and `{}` rather than omitted, and no
 * anchors or line folding. Round-tripping is explicitly not a goal — `--json`
 * is the machine-readable form.
 */
export function renderYaml(value: unknown, indent = 0): string[] {
  const pad = '  '.repeat(indent)

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    return value.flatMap((entry) => {
      const rendered = renderYaml(entry, indent + 1)
      const [first = '', ...rest] = rendered
      return [`${pad}- ${first.trimStart()}`, ...rest]
    })
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    if (entries.length === 0) return [`${pad}{}`]
    return entries.flatMap(([key, entry]) => {
      if (isScalar(entry)) return [`${pad}${key}: ${scalar(entry)}`]
      if (Array.isArray(entry) && entry.length === 0) return [`${pad}${key}: []`]
      if (!Array.isArray(entry) && Object.keys(entry as object).length === 0) {
        return [`${pad}${key}: {}`]
      }
      return [`${pad}${key}:`, ...renderYaml(entry, indent + 1)]
    })
  }

  return [`${pad}${scalar(value)}`]
}

function isScalar(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function')
}

function scalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') {
    if (value.includes('\n')) return JSON.stringify(value)
    return value === '' ? "''" : value
  }
  return String(value)
}

/** Re-exported so `doctor` can print the same masked view. */
export type { Ui }
