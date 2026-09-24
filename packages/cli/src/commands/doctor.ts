/**
 * `sitebot doctor` — diagnose a deployment before it embarrasses you.
 *
 * The checks are ordered by how early they fail in a real run: a missing
 * environment variable stops everything, an unreachable provider stops every
 * request, a stale index degrades answers. That ordering matters more than it
 * looks — a developer reads the first failure and stops, so the first failure
 * has to be the root cause rather than a symptom.
 *
 * Every check reports one of four states. `pass` and `fail` are obvious;
 * `warn` is something that works but will bite in production; `skip` is a check
 * that does not apply, and is printed rather than hidden so the absence of a
 * knowledge index does not look like a passing knowledge index.
 *
 * `--production` runs the deployment checklist from docs/08-security.md §13
 * instead — see {@link productionDoctor}.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  PROVIDER_ENV_VARS,
  PROVIDER_PACKAGES,
  providerInstallSpec,
  containsEnvPlaceholder,
  type ResolvedConfig,
} from '@sitebot/config'
import { createEngine, importProviderPackage } from '@sitebot/core'
import { connectStdioMcp, createNodeSessionStore, createSafeFetch } from '@sitebot/core/node'
import { lazySessionStore } from '@sitebot/server/node'
import { readManifest } from '@sitebot/ingest'
import type { FlagSpecs } from '../args.js'
import { formatMs, type Ui } from '../terminal.js'
import { findInlineSecrets, productionDoctor } from '../production.js'
import {
  loadForCommand,
  reportConfigError,
  type CommandContext,
  type CommandResult,
} from './context.js'

export const DOCTOR_FLAGS: FlagSpecs = {
  production: {
    type: 'boolean',
    summary: 'Run the deployment checklist from docs/08-security.md §13 instead.',
  },
  offline: { type: 'boolean', summary: 'Skip every check that needs the network.' },
  json: { type: 'boolean', summary: 'Emit the report as JSON.' },
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
  fix?: string
}

export interface DiagnosticReport {
  checks: Check[]
  ok: boolean
}

export async function runDoctor(context: CommandContext): Promise<CommandResult> {
  const { ui, flags, cwd } = context

  let loaded
  try {
    loaded = await loadForCommand(context)
  } catch (error) {
    return { exitCode: reportConfigError(ui, error) }
  }

  const { config } = loaded

  if (flags['production'] === true) {
    const gitignore = await readFile(resolve(cwd, '.gitignore'), 'utf8').catch(() => null)
    const report = productionDoctor(config, { gitignore })

    if (flags['json'] === true) {
      ui.line(JSON.stringify(report, null, 2))
      return { exitCode: report.ok ? 0 : 1 }
    }

    ui.heading('Production checklist — docs/08-security.md §13')
    for (const check of report.checks) {
      if (check.manual === true) ui.info(`${bold(ui, check.label)} — ${check.detail}`)
      else if (check.ok) ui.success(`${bold(ui, check.label)} — ${check.detail}`)
      else ui.fail(`${bold(ui, check.label)} — ${check.detail}`)
    }
    ui.line()
    if (report.ok) ui.success('Ready to deploy, once the manual items are confirmed.')
    else ui.fail('Not ready. Fix the failures above.')
    return { exitCode: report.ok ? 0 : 1 }
  }

  const report = await diagnose(config, {
    cwd,
    env: context.env,
    offline: flags['offline'] === true,
    ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }),
  })

  if (flags['json'] === true) {
    ui.line(JSON.stringify(report, null, 2))
    return { exitCode: report.ok ? 0 : 1 }
  }

  ui.heading('sitebot doctor')
  for (const check of report.checks) print(ui, check)

  const failures = report.checks.filter((check) => check.status === 'fail').length
  const warnings = report.checks.filter((check) => check.status === 'warn').length
  ui.line()
  if (failures > 0) {
    ui.fail(`${failures} ${failures === 1 ? 'failure' : 'failures'}, ${warnings} warnings.`)
  } else if (warnings > 0) {
    ui.warn(`No failures, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}.`)
  } else {
    ui.success('Everything checks out.')
  }
  ui.line()
  ui.info('Run `sitebot doctor --production` before exposing the endpoint publicly.')

  return { exitCode: report.ok ? 0 : 1 }
}

function print(ui: Ui, check: Check): void {
  const label = bold(ui, check.name)
  switch (check.status) {
    case 'pass':
      ui.success(`${label} — ${check.detail}`)
      break
    case 'warn':
      ui.warn(`${label} — ${check.detail}`)
      break
    case 'fail':
      ui.fail(`${label} — ${check.detail}`)
      break
    case 'skip':
      ui.line(`${ui.style('–', 'dim')} ${label} — ${ui.style(check.detail, 'dim')}`)
      break
  }
  if (check.fix !== undefined) ui.step(check.fix)
}

function bold(ui: Ui, text: string): string {
  return ui.style(text, 'bold')
}

// ── the diagnostics ─────────────────────────────────────────────────────────

export interface DiagnoseOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  offline?: boolean
  fetchImpl?: typeof fetch
}

export async function diagnose(
  config: ResolvedConfig,
  options: DiagnoseOptions,
): Promise<DiagnosticReport> {
  const checks: Check[] = [
    ...envChecks(config, options.env),
    ...(await providerChecks(config, options)),
    ...secretChecks(config),
    ...corsChecks(config),
    ...(await knowledgeChecks(config, options)),
    ...storageChecks(config),
  ]

  return { checks, ok: !checks.some((check) => check.status === 'fail') }
}

/**
 * Environment variables the config asks for.
 *
 * `$meta.envPaths` records every path that contained a `${env.*}`, but not the
 * variable names, and a resolved config no longer has the placeholders in it.
 * So this checks the provider's conventional variable — which is what the
 * scaffolded config uses and what a developer forgets — plus any path that
 * resolved to an empty string, which is what a missing variable with a `:-`
 * default looks like after resolution.
 */
function envChecks(config: ResolvedConfig, env: NodeJS.ProcessEnv): Check[] {
  const checks: Check[] = []
  const entries = [config.backend, ...config.backend.fallback]

  const seen = new Set<string>()
  for (const entry of entries) {
    const variable = PROVIDER_ENV_VARS[entry.provider]
    if (variable === null || seen.has(variable)) continue
    seen.add(variable)

    // An explicit `apiKey` that resolved to a non-empty value means the key
    // arrived some other way, and the conventional variable is irrelevant.
    const hasInlineKey = entry.apiKey !== undefined && entry.apiKey !== ''
    const value = env[variable]

    if (value !== undefined && value !== '') {
      checks.push({
        name: `env ${variable}`,
        status: 'pass',
        detail: `set (${mask(value)})`,
      })
    } else if (hasInlineKey) {
      checks.push({
        name: `env ${variable}`,
        status: 'pass',
        detail: 'not needed — backend.apiKey resolved to a value',
      })
    } else {
      checks.push({
        name: `env ${variable}`,
        status: 'fail',
        detail: `not set, and ${entry.provider} needs it`,
        fix: `Add ${variable}= to .env.local, or set backend.apiKey.`,
      })
    }
  }

  if (config.security.auth.mode !== 'none' && config.security.auth.jwt?.secret === '') {
    checks.push({
      name: 'env jwt secret',
      status: 'fail',
      detail: 'security.auth.jwt.secret resolved to an empty string',
      fix: 'The environment variable behind it is unset.',
    })
  }

  return checks
}

/**
 * Provider reachability.
 *
 * Two separate things, reported separately because the fixes are different: is
 * the SDK installed, and does the engine consider the provider healthy. The
 * second uses `engine.health()` rather than a bespoke probe so `doctor` and
 * `GET /health` cannot disagree — and, as documented there, it resolves the
 * model without spending a token.
 */
async function providerChecks(config: ResolvedConfig, options: DiagnoseOptions): Promise<Check[]> {
  const checks: Check[] = []
  const entries = [config.backend, ...config.backend.fallback]

  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.provider)) continue
    seen.add(entry.provider)

    const specifier = PROVIDER_PACKAGES[entry.provider]
    if (specifier === null) {
      checks.push({
        name: `provider ${entry.provider}`,
        status: 'skip',
        detail: 'no SDK package to check',
      })
      continue
    }

    try {
      await importProviderPackage(entry.provider, { baseDir: config.$meta.baseDir })
      checks.push({
        name: `provider ${entry.provider}`,
        status: 'pass',
        detail: `${specifier} installed`,
      })
    } catch (error) {
      checks.push({
        name: `provider ${entry.provider}`,
        status: 'fail',
        detail: `${specifier} is not installed`,
        fix:
          error instanceof Error
            ? firstLine(error.message)
            : `pnpm add ${providerInstallSpec(specifier)}`,
      })
    }
  }

  if (options.offline === true) {
    checks.push({ name: 'provider health', status: 'skip', detail: 'skipped (--offline)' })
    return checks
  }

  const safe = createSafeFetch()
  const engine = createEngine(config, {
    fetchImpl: options.fetchImpl ?? safe.fetch,
    resolveHost: safe.resolveHost,
    connectStdioMcp,
    // sqlite/redis/postgres/custom are Node-only, so the edge-safe engine
    // factory refuses them; build the store the way `serve` does. Opened
    // lazily, a store that cannot connect becomes a failing storage check.
    ...(config.storage.type === 'memory' || config.storage.type === 'none'
      ? {}
      : {
          sessionStore: lazySessionStore(() =>
            createNodeSessionStore(config.storage, { baseDir: config.$meta.baseDir }),
          ),
        }),
  })

  try {
    const started = Date.now()
    const health = await engine.health()
    const elapsed = Date.now() - started

    for (const [name, check] of Object.entries(health.checks)) {
      const latency = check.latencyMs === undefined ? '' : ` in ${formatMs(check.latencyMs)}`
      checks.push({
        name: `health ${name}`,
        status: check.status === 'ok' ? 'pass' : check.status === 'degraded' ? 'warn' : 'fail',
        detail: check.error ?? `${check.status}${latency}`,
      })
    }

    checks.push({
      name: 'health overall',
      status: health.status === 'ok' ? 'pass' : health.status === 'degraded' ? 'warn' : 'fail',
      detail: `${health.status}, ${health.config.toolCount} tools, mode ${health.config.mode} (${formatMs(elapsed)})`,
    })
  } catch (error) {
    checks.push({
      name: 'health overall',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await engine.dispose()
  }

  return checks
}

/**
 * Inline secrets — docs/08-security.md §2.
 *
 * The same scan the production checklist runs, surfaced in the default run
 * because a key committed to a config file is worth catching on the developer's
 * machine rather than in a review.
 */
function secretChecks(config: ResolvedConfig): Check[] {
  const findings = findInlineSecrets(config)
  if (findings.length === 0) {
    return [{ name: 'inline secrets', status: 'pass', detail: 'no literal-looking secrets found' }]
  }
  return [
    {
      name: 'inline secrets',
      status: 'fail',
      detail: `literal-looking secrets at ${findings.join(', ')}`,
      fix: 'Move them to ${env.VAR} — a committed key is a rotated key.',
    },
  ]
}

/** CORS, per docs/08-security.md §7. */
function corsChecks(config: ResolvedConfig): Check[] {
  const origins = config.security.allowedOrigins

  if (origins.includes('*')) {
    return [
      {
        name: 'cors',
        status: 'fail',
        detail: "allowedOrigins contains '*'",
        fix: 'List the origins that embed the widget. A wildcard lets any page spend your tokens.',
      },
    ]
  }

  if (origins.length === 0) {
    return [
      {
        name: 'cors',
        status: 'pass',
        detail: 'same-origin only — correct for a route mounted in your own app',
      },
    ]
  }

  const bad = origins.filter((origin) => !isValidOrigin(origin))
  if (bad.length > 0) {
    return [
      {
        name: 'cors',
        status: 'fail',
        detail: `not valid origins: ${bad.join(', ')}`,
        fix: 'An origin is scheme + host + optional port, with no path — https://acme.com.',
      },
    ]
  }

  const insecure = origins.filter((origin) => origin.startsWith('http://') && !isLocal(origin))
  return [
    {
      name: 'cors',
      status: insecure.length > 0 ? 'warn' : 'pass',
      detail:
        insecure.length > 0
          ? `${origins.length} origins, but ${insecure.join(', ')} are plaintext http`
          : `${origins.length} explicit ${origins.length === 1 ? 'origin' : 'origins'}`,
    },
  ]
}

/**
 * Knowledge: store health, index freshness, retrieval smoke test.
 *
 * All three are `skip` when no sources are configured, because layers 1 and 2
 * work without an index (docs/06 §1) and reporting a missing index as a failure
 * would make a perfectly good chat-only deployment look broken.
 */
async function knowledgeChecks(config: ResolvedConfig, options: DiagnoseOptions): Promise<Check[]> {
  const { knowledge } = config

  if (knowledge.sources.length === 0) {
    return [
      {
        name: 'knowledge',
        status: 'skip',
        detail: 'no sources configured — siteContext and page context still apply',
      },
    ]
  }

  const checks: Check[] = []

  if (knowledge.embedding === undefined) {
    checks.push({
      name: 'knowledge embedding',
      status: 'fail',
      detail: 'sources are configured but knowledge.embedding is not',
      fix: 'Set knowledge.embedding.provider and .model, then run `sitebot ingest`.',
    })
  }

  // Sensitive routes reaching the index — docs/06 §6.
  const sensitive = knowledge.sources
    .filter(
      (source): source is Extract<typeof source, { type: 'sitemap' | 'crawl' }> =>
        source.type === 'sitemap' || source.type === 'crawl',
    )
    .filter((source) => !source.exclude.some((glob) => /admin|account|internal/i.test(glob)))
  if (sensitive.length > 0) {
    checks.push({
      name: 'knowledge exclusions',
      status: 'warn',
      detail: `${sensitive.length} web ${sensitive.length === 1 ? 'source excludes' : 'sources exclude'} nothing under /admin, /account or /internal`,
      fix: 'Add exclude globs before ingesting, or a logged-in page ends up in the index.',
    })
  }

  checks.push(await indexCheck(config, options))

  if (options.offline !== true && knowledge.store.type === 'sqlite') {
    const path = resolve(options.cwd, knowledge.store.path)
    const present = await readFile(path).then(
      () => true,
      () => false,
    )
    checks.push({
      name: 'knowledge store',
      status: present ? 'pass' : 'warn',
      detail: present ? `sqlite at ${knowledge.store.path}` : `no index at ${knowledge.store.path}`,
      ...(present ? {} : { fix: 'Run `sitebot ingest` to build it.' }),
    })
  }

  return checks
}

/** An index older than this is reported as stale — docs/06 §5 re-ingest cadence. */
export const INDEX_STALE_AFTER_DAYS = 7

/**
 * The ingest manifest is the index's own record of what it holds and which
 * embedding model built it (docs/06 §3.6), so it answers the three questions
 * that matter without a network call: was it built, does it match the
 * configured model, and how old is it.
 */
async function indexCheck(config: ResolvedConfig, options: DiagnoseOptions): Promise<Check> {
  const manifest = await readManifest({ dir: options.cwd })
  if (manifest === null) {
    return {
      name: 'knowledge index',
      status: 'warn',
      detail: 'no index has been built — answers fall back to siteContext and page context',
      fix: 'Run `sitebot ingest` (add --dry-run first for a cost estimate).',
    }
  }
  const model = config.knowledge.embedding?.model
  if (model !== undefined && manifest.model !== model) {
    return {
      name: 'knowledge index',
      status: 'fail',
      detail: `built with "${manifest.model}" but knowledge.embedding.model is "${model}"`,
      fix: 'Embedding spaces do not mix: run `sitebot ingest --force` to rebuild.',
    }
  }
  const documents = Object.values(manifest.sources).reduce(
    (total, source) => total + Object.keys(source.documents).length,
    0,
  )
  const ageDays = (Date.now() - Date.parse(manifest.builtAt)) / 86_400_000
  const age = ageDays < 1 ? 'today' : `${Math.floor(ageDays)} day${ageDays < 2 ? '' : 's'} ago`
  const stale = ageDays > INDEX_STALE_AFTER_DAYS
  return {
    name: 'knowledge index',
    status: documents === 0 || stale ? 'warn' : 'pass',
    detail: `${documents} document${documents === 1 ? '' : 's'}, built ${age} with ${manifest.model}`,
    ...(documents === 0
      ? { fix: 'The sources matched nothing — check their URLs, globs and exclude patterns.' }
      : stale
        ? { fix: 'Re-run `sitebot ingest`; unchanged pages cost no embedding calls.' }
        : {}),
  }
}

function storageChecks(config: ResolvedConfig): Check[] {
  const checks: Check[] = []

  if (config.mode === 'agent' && config.storage.type === 'memory') {
    checks.push({
      name: 'storage',
      status: 'warn',
      detail: 'agent mode on memory storage — approvals and resume are lost on restart',
      fix: 'Use sqlite, redis or postgres for anything longer-lived than a demo.',
    })
  } else {
    checks.push({ name: 'storage', status: 'pass', detail: `${config.storage.type}` })
  }

  const url = 'url' in config.storage ? config.storage.url : undefined
  if (url !== undefined && containsEnvPlaceholder(url)) {
    checks.push({
      name: 'storage url',
      status: 'fail',
      detail: 'still contains an unresolved ${env.*} placeholder',
    })
  }

  return checks
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isValidOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return `${url.protocol}//${url.host}` === origin.replace(/\/$/, '')
  } catch {
    return false
  }
}

function isLocal(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)
}

/** Enough of a value to recognise it, not enough to use it. */
function mask(value: string): string {
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}

function firstLine(message: string): string {
  return (
    message
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[1] ?? message
  )
}
