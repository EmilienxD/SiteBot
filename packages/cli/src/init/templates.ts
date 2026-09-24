/**
 * The files `sitebot init` writes.
 *
 * Every template is a pure function of the answers, so the whole scaffold can
 * be asserted in a test without touching a filesystem. Comments in the emitted
 * files are deliberate: the scaffold is the documentation most developers will
 * actually read, and docs/05-tools.md §7 and docs/06-knowledge.md §4 both call
 * for `init` to demonstrate the good pattern rather than describe it.
 */

import { createRequire } from 'node:module'
import {
  PROVIDER_ENV_VARS,
  PROVIDER_PACKAGES,
  providerInstallSpec,
  type ProviderId,
} from '@sitebot/config'
import type { Framework } from './detect.js'
import type { SiteDraft } from './site-draft.js'

export interface ScaffoldAnswers {
  name: string
  provider: ProviderId
  model: string
  framework: Framework
  typescript: boolean
  srcDir: boolean
  basePath: string
  draft: SiteDraft | null
  siteUrl: string | null
  /** Self-hosted widget rather than the CDN — docs/08-security.md §11. */
  selfHostWidget: boolean
}

export interface ScaffoldFile {
  /** Relative to the project root, POSIX separators. */
  path: string
  contents: string
  /** Printed after writing, when the file needs a manual follow-up. */
  note?: string
}

export const CONFIG_FILENAME = 'chatbot.config.yaml'

/** The `# yaml-language-server:` line from docs/02-configuration.md §14. */
export const SCHEMA_LINE =
  '# yaml-language-server: $schema=./node_modules/@sitebot/config/schema/chatbot.schema.json'

export function configFile(answers: ScaffoldAnswers): ScaffoldFile {
  const envVar = PROVIDER_ENV_VARS[answers.provider]
  const draft = answers.draft

  const lines: string[] = [
    SCHEMA_LINE,
    '',
    'version: 1',
    `name: ${yamlString(answers.name)}`,
    '',
    '# chat: one step, read-only tools. agent: multi-step with approval gates.',
    '# Start in chat mode — switch to agent when you add a tool that does something.',
    'mode: chat',
    '',
    'backend:',
    `  provider: ${answers.provider}`,
    `  model: ${yamlString(answers.model)}`,
  ]

  if (envVar !== null) {
    lines.push(`  apiKey: \${env.${envVar}}`)
  } else {
    lines.push(`  # This provider reads credentials from its own environment (see docs/02 §4).`)
  }
  if (answers.provider === 'openai-compatible') {
    lines.push('  baseUrl: ${env.OPENAI_BASE_URL} # required for openai-compatible')
  }
  if (answers.provider === 'ollama') {
    lines.push('  baseUrl: http://localhost:11434/api')
  }

  lines.push(
    '  maxOutputTokens: 1024',
    '  temperature: 0.3',
    '',
    'prompt:',
    '  system: |',
    ...systemPrompt(answers).map((line) => `    ${line}`),
    '  includePageContext: true',
    '  includeSiteContext: true',
    '  guardrails:',
    '    refuseOffTopic: true',
    '',
    '# Layer 1 of the knowledge stack: hand-written facts, always in the prompt,',
    '# no infrastructure. Drafted from your homepage — check every line.',
    'siteContext:',
  )

  if (draft?.company !== undefined) lines.push(`  company: ${yamlString(draft.company)}`)
  if (draft?.description !== undefined) {
    lines.push(`  description: ${yamlString(draft.description)}`)
  }
  if (draft?.primaryUrl !== undefined) lines.push(`  primaryUrl: ${yamlString(draft.primaryUrl)}`)

  if (draft === null || draft.company === undefined) {
    lines.push('  # company: Acme Inc')
  }
  if (draft === null || draft.description === undefined) {
    lines.push('  # description: What the company does, in one sentence.')
  }

  // An empty-but-present `facts` validates; a key whose only lines are
  // comments parses as null and does not.
  lines.push(
    '  # One fact per line. These go into every prompt, so keep them short and',
    '  # keep them true — this is the cheapest knowledge you will ever add.',
    '  # Example: - Support replies within one business day.',
    '  facts: []',
  )

  if (draft !== null && draft.routes.length > 0) {
    lines.push(
      '  routes:',
      '    # Doubles as the allowlist for the `navigate` tool: the assistant cannot',
      '    # send a visitor anywhere that is not listed here.',
    )
    for (const route of draft.routes) {
      lines.push(`    - path: ${yamlString(route.path)}`)
      if (route.summary !== undefined) lines.push(`      summary: ${yamlString(route.summary)}`)
    }
  } else {
    // Same null-versus-empty point as `facts` above.
    lines.push(
      '  # Doubles as the allowlist for the `navigate` tool:',
      '  # - path: /pricing',
      '  #   summary: Plans and per-seat pricing.',
      '  routes: []',
    )
  }

  lines.push(
    '',
    '# Layer 3 — the indexed corpus. Add a source, run `sitebot ingest`, and the',
    '# assistant can quote your site. Layers 1 and 2 already work without it.',
    '# knowledge:',
    '#   sources:',
    `#     - type: sitemap`,
    `#       url: ${draft?.primaryUrl ?? 'https://example.com'}/sitemap.xml`,
    '#   embedding:',
    '#     provider: openai',
    '#     model: text-embedding-3-small',
    '#   store:',
    '#     type: sqlite',
    '',
    '# Tools let the assistant act. In chat mode every tool must be readOnly.',
    '# The tool description is the highest-leverage thing in this file: it is the',
    '# only thing the model reads when deciding whether to call it (docs/05 §7).',
    '# tools:',
    '#   - name: check_order_status',
    '#     description: >-',
    '#       Look up the delivery status of a customer order by its order number.',
    '#       Use when the visitor asks where their order is or when it will arrive.',
    '#       Requires the order number — ask for it first if it was not given.',
    '#     readOnly: true',
    '#     scope: authenticated',
    '#     parameters:',
    '#       type: object',
    '#       properties:',
    '#         orderNumber: { type: string, description: "e.g. NW-10432" }',
    '#       required: [orderNumber]',
    '#     executor:',
    '#       type: http',
    '#       url: https://api.example.com/orders/{orderNumber}',
    '#       allowHosts: [api.example.com]',
    '',
    'ui:',
    '  position: bottom-right',
    '  messages:',
    `    greeting: ${yamlString(greeting(answers))}`,
    '    suggestions:',
    ...suggestions(draft).flatMap((suggestion) => [
      `      - label: ${yamlString(suggestion.label)}`,
      '        action:',
      '          type: send',
      `          text: ${yamlString(suggestion.text)}`,
    ]),
    '',
    'security:',
    '  # Empty means same-origin only. A sidecar deployment must list the site',
    "  # origins explicitly — '*' is rejected in production by `sitebot doctor`.",
    '  allowedOrigins: []',
    '  rateLimit:',
    '    perSession: 30/5m',
    '    perIp: 100/1h',
    '',
  )

  return { path: CONFIG_FILENAME, contents: `${lines.join('\n')}` }
}

function systemPrompt(answers: ScaffoldAnswers): string[] {
  const company = answers.draft?.company ?? answers.name
  return [
    `You are the assistant for ${company}'s website.`,
    '',
    'Answer questions about the site using the site context you are given.',
    'Keep answers short — two or three sentences unless the visitor asks for',
    'detail. When you do not know something, say so and point the visitor at',
    'the page most likely to help. Never invent prices, dates or policies.',
  ]
}

function greeting(answers: ScaffoldAnswers): string {
  const company = answers.draft?.company ?? answers.name
  return `Hi! Ask me anything about ${company}.`
}

function suggestions(draft: SiteDraft | null): { label: string; text: string }[] {
  const routes = draft?.routes ?? []
  const pick = (pattern: RegExp) => routes.find((route) => pattern.test(route.path))

  const chosen: { label: string; text: string }[] = []
  const pricing = pick(/pricing|plans/i)
  if (pricing !== undefined) {
    chosen.push({ label: 'How much does it cost?', text: 'How much does it cost?' })
  }
  const docs = pick(/docs|documentation|guide/i)
  if (docs !== undefined) {
    chosen.push({ label: 'How do I get started?', text: 'How do I get started?' })
  }
  if (chosen.length < 2) {
    chosen.push({ label: 'What do you do?', text: 'What does this company do?' })
  }
  return chosen.slice(0, 3)
}

// ── route handlers ──────────────────────────────────────────────────────────

/**
 * The server-side integration, one file per framework.
 *
 * Each mounts a *catch-all* route. All four endpoints (`POST /`, `GET /config`,
 * `POST /feedback`, `GET /health`) live under one base path, so a non-catch-all
 * route would serve only the first and the widget's config fetch would 404 —
 * the single most confusing way for a first run to fail.
 */
export function routeFile(answers: ScaffoldAnswers): ScaffoldFile | null {
  const ext = answers.typescript ? 'ts' : 'js'
  const base = answers.basePath.replace(/^\//, '')

  switch (answers.framework) {
    case 'next-app': {
      const root = answers.srcDir ? 'src/app' : 'app'
      return {
        path: `${root}/${base}/[[...route]]/route.${ext}`,
        contents: nextAppRoute(answers),
      }
    }
    case 'next-pages': {
      const root = answers.srcDir ? 'src/pages' : 'pages'
      return { path: `${root}/${base}/[[...route]].${ext}`, contents: nextPagesRoute(answers) }
    }
    case 'nuxt':
      return { path: `server/${base}/[...route].${ext}`, contents: nuxtRoute(answers) }
    case 'sveltekit':
      return {
        path: `src/routes/${base}/[...route]/+server.${ext}`,
        contents: svelteKitRoute(answers),
      }
    case 'astro':
      return { path: `src/pages/${base}/[...route].${ext}`, contents: astroRoute(answers) }
    case 'static':
      return null
  }
}

const LOADER_COMMENT = `/**
 * The whole server-side integration.
 *
 * The config is loaded once per process, not once per request: building an
 * engine per request would also build a fresh in-memory session store and rate
 * limiter, which makes both look broken while you develop against them.
 */`

/**
 * Node deps, wired by hand for the frameworks that have no adapter of their own.
 *
 * \`withNodeRuntime\` adds what a Node host needs on top of the edge-safe
 * handler: the SSRF guard for \`http\` tools (docs/08-security.md §5), the stdio
 * MCP transport, and the sqlite/redis/postgres session and rate-limit stores.
 * The Next.js and Node adapters apply it for you; Nuxt, SvelteKit and Astro
 * hand over a \`Request\` directly, so their scaffold applies it explicitly.
 */
const NODE_DEPS_COMMENT = `// withNodeRuntime wires the SSRF guard for \`http\` tools (docs/08-security.md §5)
// and the Node-only session stores. Without it an http tool can be pointed at
// the cloud metadata endpoint.`

function nextAppRoute(answers: ScaffoldAnswers): string {
  return `import { loadConfig } from '@sitebot/config/node'
import { createRouteHandlers } from '@sitebot/server/next'

${LOADER_COMMENT}

// \`nodejs\` because the config loader reads ${CONFIG_FILENAME} from disk.
// A deployment that passes a config object instead can run this on the edge.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const config = await loadConfig(undefined, { dotenv: true })

export const { GET, POST, OPTIONS } = createRouteHandlers(config, {
  basePath: ${JSON.stringify(answers.basePath)},
})
`
}

function nextPagesRoute(answers: ScaffoldAnswers): string {
  return `import { loadConfig } from '@sitebot/config/node'
import { createNodeHandler, type NodeHandler } from '@sitebot/server/node'
import type { NextApiRequest, NextApiResponse } from 'next'

${LOADER_COMMENT}

// Streaming needs the raw request and response, so Next's body parser is off
// and the route is marked as resolving itself.
export const config = { api: { bodyParser: false, externalResolver: true } }

let handler: Promise<NodeHandler> | undefined

function get(): Promise<NodeHandler> {
  handler ??= loadConfig(undefined, { dotenv: true }).then((resolved) =>
    createNodeHandler(resolved, { basePath: ${JSON.stringify(answers.basePath)} }),
  )
  return handler
}

export default async function route(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  await (await get())(req, res)
}
`
}

function nuxtRoute(answers: ScaffoldAnswers): string {
  return `import { loadConfig } from '@sitebot/config/node'
import { createSiteBotHandler, type SiteBotHandler } from '@sitebot/server'
import { withNodeRuntime } from '@sitebot/server/node'

${LOADER_COMMENT}

let handler: Promise<SiteBotHandler> | undefined

function get(): Promise<SiteBotHandler> {
  handler ??= loadConfig(undefined, { dotenv: true }).then((config) => {
    ${NODE_DEPS_COMMENT.split('\n').join('\n    ')}
    return createSiteBotHandler(
      config,
      withNodeRuntime(config, { basePath: ${JSON.stringify(answers.basePath)} }),
    )
  })
  return handler
}

// \`defineEventHandler\` and \`toWebRequest\` are Nuxt auto-imports.
export default defineEventHandler(async (event) => await (await get())(toWebRequest(event)))
`
}

function svelteKitRoute(answers: ScaffoldAnswers): string {
  return `import { loadConfig } from '@sitebot/config/node'
import { createSiteBotHandler, type SiteBotHandler } from '@sitebot/server'
import { withNodeRuntime } from '@sitebot/server/node'
import type { RequestHandler } from './$types'

${LOADER_COMMENT}

let handler: Promise<SiteBotHandler> | undefined

function get(): Promise<SiteBotHandler> {
  handler ??= loadConfig(undefined, { dotenv: true }).then((config) => {
    ${NODE_DEPS_COMMENT.split('\n').join('\n    ')}
    return createSiteBotHandler(
      config,
      withNodeRuntime(config, { basePath: ${JSON.stringify(answers.basePath)} }),
    )
  })
  return handler
}

const dispatch: RequestHandler = async ({ request }) => await (await get())(request)

export const GET = dispatch
export const POST = dispatch
export const OPTIONS = dispatch
`
}

function astroRoute(answers: ScaffoldAnswers): string {
  return `import { loadConfig } from '@sitebot/config/node'
import { createSiteBotHandler, type SiteBotHandler } from '@sitebot/server'
import { withNodeRuntime } from '@sitebot/server/node'
import type { APIRoute } from 'astro'

${LOADER_COMMENT}

// The endpoint streams, so it cannot be prerendered.
export const prerender = false

let handler: Promise<SiteBotHandler> | undefined

function get(): Promise<SiteBotHandler> {
  handler ??= loadConfig(undefined, { dotenv: true }).then((config) => {
    ${NODE_DEPS_COMMENT.split('\n').join('\n    ')}
    return createSiteBotHandler(
      config,
      withNodeRuntime(config, { basePath: ${JSON.stringify(answers.basePath)} }),
    )
  })
  return handler
}

const dispatch: APIRoute = async ({ request }) => await (await get())(request)

export const GET = dispatch
export const POST = dispatch
export const OPTIONS = dispatch
`
}

// ── the script tag ──────────────────────────────────────────────────────────

/**
 * The CDN URL for the widget that shipped with this CLI.
 *
 * The widget and the CLI are released in lockstep (one changesets `fixed`
 * group), so the CLI's own version names a widget that exists. The range
 * follows semver's own compatibility line: `@1` from 1.0 on, but `@0.3` on
 * 0.x, where a minor bump may break — and a hard-coded `@1` would 404 on every
 * 0.x release.
 */
export function widgetCdnUrl(version: string): string {
  const [major = '0', minor = '0'] = version.split('.')
  const range = major === '0' ? `0.${minor}` : major
  return `https://cdn.jsdelivr.net/npm/@sitebot/widget@${range}/dist/sitebot.js`
}

const CLI_VERSION = (
  createRequire(import.meta.url)('@sitebot/cli/package.json') as { version: string }
).version

export const WIDGET_CDN_URL = widgetCdnUrl(CLI_VERSION)
export const WIDGET_SELF_HOSTED_URL = '/sitebot.js'

/**
 * The one-line browser integration (docs/07-widget.md §1).
 *
 * Self-hosting is offered because a CDN script tag is a live code-execution
 * dependency on a third party (docs/08-security.md §11). When the developer
 * declines it, the CDN URL is version-pinned rather than floating.
 */
export function scriptTag(answers: ScaffoldAnswers): string {
  const src = answers.selfHostWidget ? WIDGET_SELF_HOSTED_URL : WIDGET_CDN_URL
  // `type="module"`, not `defer`: the bundle is an ES module so the panel can
  // load as a separate chunk (docs/07 §1). Modules are deferred by default.
  return [
    '<script',
    '  type="module"',
    `  src="${src}"`,
    `  data-endpoint="${answers.basePath}"`,
    '></script>',
  ].join('\n')
}

/** Where the script tag goes, per framework. Printed, not written. */
export function scriptTagLocation(framework: Framework, srcDir: boolean): string {
  const prefix = srcDir ? 'src/' : ''
  switch (framework) {
    case 'next-app':
      return `${prefix}app/layout.tsx — inside <body>, using next/script`
    case 'next-pages':
      return `${prefix}pages/_document.tsx — inside <body>`
    case 'nuxt':
      return 'nuxt.config.ts — app.head.script, or app.vue'
    case 'sveltekit':
      return 'src/app.html — before </body>'
    case 'astro':
      return 'src/layouts/Layout.astro — before </body>'
    case 'static':
      return 'your page template — before </body>'
  }
}

export function envExample(answers: ScaffoldAnswers): ScaffoldFile | null {
  const envVar = PROVIDER_ENV_VARS[answers.provider]
  const lines = [
    '# Copy to .env.local and fill in. Both files are read by the config loader',
    '# when it runs with `dotenv: true`; neither should ever be committed.',
    '',
  ]

  if (envVar === null && answers.provider !== 'openai-compatible') {
    return null
  }
  if (envVar !== null) {
    lines.push(`# The only variable needed for a working assistant.`, `${envVar}=`)
  }
  if (answers.provider === 'openai-compatible') {
    lines.push('', '# Required for provider: openai-compatible.', 'OPENAI_BASE_URL=')
  }

  return { path: '.env.example', contents: `${lines.join('\n')}\n` }
}

/** npm packages the chosen setup needs but the project may not have yet. */
export function requiredPackages(answers: ScaffoldAnswers): string[] {
  const packages = ['@sitebot/config', '@sitebot/server']
  if (answers.framework === 'static') packages.push('@sitebot/cli')
  const provider = PROVIDER_PACKAGES[answers.provider]
  if (provider !== null) packages.push(providerInstallSpec(provider))
  if (!answers.selfHostWidget) return packages
  return [...packages, '@sitebot/widget']
}

/**
 * YAML scalar quoting.
 *
 * Only quote when the value would otherwise change meaning — an unquoted
 * `yes`, `1.0` or `null` is a different type to YAML, and a leading `#` or a
 * colon-space breaks parsing outright. Over-quoting would make the scaffolded
 * file look machine-generated, which is the opposite of the goal.
 */
export function yamlString(value: string): string {
  const needsQuote =
    value === '' ||
    /^[\s]|[\s]$/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s|\s#/.test(value) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(value) ||
    /^[+-]?(\d[\d_]*(\.\d*)?([eE][+-]?\d+)?|\.\d+|0x[\da-fA-F]+|0o[0-7]+)$/.test(value) ||
    value.includes('\n')

  if (!needsQuote) return value
  return `'${value.replaceAll("'", "''")}'`
}
