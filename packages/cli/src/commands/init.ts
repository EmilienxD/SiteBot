import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { PROVIDERS, type ProviderId } from '@sitebot/config'
import { findConfigFile } from '@sitebot/config/node'
import { DEFAULT_BASE_PATH } from '@sitebot/server'
import { type FlagSpecs } from '../args.js'
import { Prompter } from '../prompt.js'
import { type Ui } from '../terminal.js'
import { detectFramework, FRAMEWORK_LABELS, FRAMEWORKS, type Framework } from '../init/detect.js'
import {
  CONFIG_FILENAME,
  configFile,
  envExample,
  requiredPackages,
  routeFile,
  type ScaffoldAnswers,
  type ScaffoldFile,
  scriptTag,
  scriptTagLocation,
} from '../init/templates.js'
import { exists, type CommandContext, type CommandResult } from './context.js'

export const INIT_FLAGS: FlagSpecs = {
  yes: {
    type: 'boolean',
    summary: 'Accept every default. Non-interactive.',
    short: 'y',
  },
  provider: { type: 'string', summary: 'Model provider.', placeholder: '<id>' },
  model: { type: 'string', summary: 'Model ID.', placeholder: '<id>' },
  name: {
    type: 'string',
    summary: 'Assistant name, shown as the panel title.',
    placeholder: '<name>',
  },
  framework: {
    type: 'string',
    summary: `Override detection: ${FRAMEWORKS.join(' | ')}.`,
    placeholder: '<id>',
  },
  'base-path': {
    type: 'string',
    summary: `Where the API route is mounted. Default ${DEFAULT_BASE_PATH}.`,
    placeholder: '<path>',
  },
  'self-host-widget': {
    type: 'boolean',
    summary: 'Serve the widget from your own origin rather than the CDN.',
  },
  force: { type: 'boolean', summary: 'Overwrite files that already exist.' },
  'dry-run': { type: 'boolean', summary: 'Print what would be written and exit.' },
}

/** The default model per provider — docs/02-configuration.md §4. */
const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-5',
  google: 'gemini-2.5-pro',
  azure: 'gpt-5',
  bedrock: 'us.anthropic.claude-opus-5-20260115-v1:0',
  vertex: 'claude-opus-5@20260115',
  mistral: 'mistral-large-latest',
  groq: 'llama-3.3-70b-versatile',
  'openai-compatible': 'gpt-4o-mini',
  ollama: 'llama3.2',
  custom: 'custom',
}

/** Offered interactively. The full list is still accepted via --provider. */
const OFFERED_PROVIDERS: { value: ProviderId; label: string; hint?: string }[] = [
  { value: 'anthropic', label: 'Anthropic', hint: 'Claude — the scaffolded default' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'ollama', label: 'Ollama', hint: 'local, no API key' },
]

export async function runInit(context: CommandContext): Promise<CommandResult> {
  const { ui, flags, cwd } = context
  const dryRun = flags['dry-run'] === true
  const force = flags['force'] === true

  ui.heading('sitebot init')

  const existing = await findConfigFile(cwd)
  if (existing !== null && !force && !dryRun) {
    ui.fatal(
      `A SiteBot config already exists at ${relative(cwd, existing) || existing}.`,
      'Edit it, or re-run with --force to overwrite. `sitebot validate` checks the one you have.',
    )
    return { exitCode: 1 }
  }

  const detection = await detectFramework(cwd)
  const framework = resolveFramework(flags['framework'], detection.framework)
  if (framework === null) {
    ui.fatal(
      `Unknown framework "${String(flags['framework'])}".`,
      `Pass one of: ${FRAMEWORKS.join(', ')}.`,
    )
    return { exitCode: 1 }
  }

  if (flags['framework'] === undefined) {
    ui.success(`Detected ${detection.label}`)
    for (const line of detection.evidence) ui.step(line)
  } else {
    ui.success(`Framework ${FRAMEWORK_LABELS[framework]} (from --framework)`)
  }

  const prompter = new Prompter({
    ui,
    ...(flags['yes'] === true ? { interactive: false } : {}),
    ...(context.answers === undefined ? {} : { answers: context.answers }),
  })

  try {
    const answers = await collect(
      context,
      prompter,
      framework,
      detection.typescript,
      detection.srcDir,
    )
    const files = buildScaffold(answers)

    if (dryRun) {
      ui.heading('Would write')
      for (const file of files) ui.step(file.path)
      ui.line()
      ui.info('Nothing was written (--dry-run).')
      return { exitCode: 0 }
    }

    const written: ScaffoldFile[] = []
    const skipped: string[] = []
    for (const file of files) {
      const target = resolve(cwd, file.path)
      if (!force && (await exists(target))) {
        skipped.push(file.path)
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.contents, 'utf8')
      written.push(file)
    }

    ui.heading('Wrote')
    for (const file of written) ui.success(file.path)
    for (const path of skipped) ui.warn(`${path} — already exists, left alone`)

    await ensureGitignore(cwd, ui)
    printNextSteps(context, answers, written)
    return { exitCode: 0 }
  } finally {
    prompter.close()
  }
}

async function collect(
  context: CommandContext,
  prompter: Prompter,
  framework: Framework,
  typescript: boolean,
  srcDir: boolean,
): Promise<ScaffoldAnswers> {
  const { ui, flags, cwd } = context

  const provider = await resolveProvider(prompter, flags['provider'], ui)
  const model = asString(flags['model']) ?? (await prompter.text('Model', DEFAULT_MODELS[provider]))

  const fallbackName = (await packageName(cwd)) ?? 'Site Assistant'
  const name = asString(flags['name']) ?? (await prompter.text('Assistant name', fallbackName))

  const basePath = normaliseBasePath(asString(flags['base-path']) ?? DEFAULT_BASE_PATH)

  const selfHostWidget =
    flags['self-host-widget'] === true ||
    (flags['self-host-widget'] === undefined &&
      (await prompter.confirm('Self-host the widget script instead of using the CDN?', false)))

  return {
    name,
    provider,
    model,
    framework,
    typescript,
    srcDir,
    basePath,
    selfHostWidget,
  }
}

async function resolveProvider(prompter: Prompter, flag: unknown, ui: Ui): Promise<ProviderId> {
  const requested = asString(flag)
  if (requested !== undefined) {
    if ((PROVIDERS as readonly string[]).includes(requested)) return requested as ProviderId
    ui.warn(`Unknown provider "${requested}" — falling back to the prompt.`)
  }
  return await prompter.select('Provider', OFFERED_PROVIDERS, 'anthropic')
}

export function buildScaffold(answers: ScaffoldAnswers): ScaffoldFile[] {
  const files: ScaffoldFile[] = [configFile(answers)]
  const route = routeFile(answers)
  if (route !== null) files.push(route)
  const env = envExample(answers)
  if (env !== null) files.push(env)
  return files
}

/**
 * `.env.local` in `.gitignore`, or a warning.
 *
 * The Phase 8 production checklist fails a deployment whose `.env` files are
 * not ignored (docs/08-security.md §2). Catching it at scaffold time is the
 * difference between a warning and a leaked key.
 */
async function ensureGitignore(cwd: string, ui: Ui): Promise<void> {
  const path = join(cwd, '.gitignore')
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current === null) return

  const lines = current.split(/\r?\n/).map((line) => line.trim())
  const missing = ['.env', '.env.local'].filter((entry) => !lines.includes(entry))
  if (missing.length === 0) return

  const separator = current.endsWith('\n') ? '' : '\n'
  await writeFile(path, `${current}${separator}\n# SiteBot\n${missing.join('\n')}\n`, 'utf8')
  ui.success(`.gitignore — added ${missing.join(', ')}`)
}

function printNextSteps(
  context: CommandContext,
  answers: ScaffoldAnswers,
  written: ScaffoldFile[],
): void {
  const { ui } = context
  const packages = requiredPackages(answers)
  const envVar = envVarFor(answers)

  ui.heading('Next steps')

  let step = 1
  const next = (text: string) => ui.line(`  ${ui.style(`${step++}.`, 'bold')} ${text}`)

  next(`Install: ${ui.style(`npm i ${packages.join(' ')}`, 'cyan')}`)
  if (envVar !== null) {
    next(`Put your key in ${ui.style('.env.local', 'cyan')}: ${ui.style(`${envVar}=…`, 'dim')}`)
  }

  if (answers.framework === 'static') {
    next(`Run the sidecar: ${ui.style('npx sitebot dev', 'cyan')}`)
    next('Add the script tag to your page template, before </body>:')
  } else {
    next(
      `Add the script tag to ${ui.style(scriptTagLocation(answers.framework, answers.srcDir), 'cyan')}:`,
    )
  }

  ui.line()
  for (const line of scriptTag(answers).split('\n')) ui.line(`     ${ui.style(line, 'dim')}`)
  ui.line()

  if (answers.selfHostWidget) {
    ui.step(
      'Self-hosting: copy node_modules/@sitebot/widget/dist/sitebot*.js into your static directory (the panel is a sibling chunk).',
    )
  }

  next(`Check it: ${ui.style('npx sitebot doctor', 'cyan')}`)

  if (written.length > 0) {
    ui.line()
    ui.info(
      `Edit ${CONFIG_FILENAME} — fill in trusted siteContext and register your application tools.`,
    )
  }
}

function envVarFor(answers: ScaffoldAnswers): string | null {
  const file = envExample(answers)
  if (file === null) return null
  const match = /^([A-Z0-9_]+)=/m.exec(file.contents)
  return match?.[1] ?? null
}

async function packageName(cwd: string): Promise<string | null> {
  const source = await readFile(join(cwd, 'package.json'), 'utf8').catch(() => null)
  if (source === null) return null
  try {
    const parsed: unknown = JSON.parse(source)
    const name = (parsed as { name?: unknown }).name
    if (typeof name !== 'string' || name === '') return null
    const bare = name.replace(/^@[^/]+\//, '').replace(/[-_]+/g, ' ')
    return `${bare.replace(/\b\w/g, (c) => c.toUpperCase())} Assistant`
  } catch {
    return null
  }
}

function resolveFramework(flag: unknown, detected: Framework): Framework | null {
  const requested = asString(flag)
  if (requested === undefined) return detected
  return (FRAMEWORKS as readonly string[]).includes(requested) ? (requested as Framework) : null
}

function normaliseBasePath(value: string): string {
  const withLeading = value.startsWith('/') ? value : `/${value}`
  return withLeading.replace(/\/+$/, '') || DEFAULT_BASE_PATH
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
