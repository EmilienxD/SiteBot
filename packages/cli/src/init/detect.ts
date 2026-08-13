/**
 * Framework detection for `sitebot init`.
 *
 * Detection drives three decisions: where the route file goes, what it
 * contains, and how the widget gets onto the page. Getting it wrong is worse
 * than not guessing, so every detector needs two signals — a dependency *and*
 * a marker file or directory — before it claims a project. A Next.js app that
 * has `astro` in devDependencies for a docs site should still be detected as
 * Next.js, which is why the order below is by specificity and the first
 * confident match wins.
 */

import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const FRAMEWORKS = [
  'next-app',
  'next-pages',
  'nuxt',
  'sveltekit',
  'astro',
  'static',
] as const
export type Framework = (typeof FRAMEWORKS)[number]

export interface Detection {
  framework: Framework
  /** Human-readable, for the "Detected …" line. */
  label: string
  /** Why we think so — printed so a wrong guess is obvious and correctable. */
  evidence: string[]
  /** Whether the project can host the API route itself, or needs the sidecar. */
  canHostRoute: boolean
  /** TypeScript when there is a tsconfig; drives the scaffolded file extension. */
  typescript: boolean
  /** `src/`-rooted layouts, which SvelteKit and many Next apps use. */
  srcDir: boolean
}

export const FRAMEWORK_LABELS: Record<Framework, string> = {
  'next-app': 'Next.js (App Router)',
  'next-pages': 'Next.js (Pages Router)',
  nuxt: 'Nuxt',
  sveltekit: 'SvelteKit',
  astro: 'Astro',
  static: 'Static site / other',
}

interface ProjectFacts {
  dependencies: Record<string, string>
  files: Set<string>
  typescript: boolean
  srcDir: boolean
}

export async function detectFramework(cwd: string): Promise<Detection> {
  const facts = await readProject(cwd)
  const has = (name: string) => facts.dependencies[name] !== undefined
  const file = (path: string) => facts.files.has(path)

  const build = (framework: Framework, evidence: string[]): Detection => ({
    framework,
    label: FRAMEWORK_LABELS[framework],
    evidence,
    canHostRoute: framework !== 'static',
    typescript: facts.typescript,
    srcDir: facts.srcDir,
  })

  if (has('next')) {
    const appDir = file('app') || file('src/app')
    const pagesDir = file('pages') || file('src/pages')
    // Both can exist during a migration. The App Router is where new routes go.
    if (appDir) return build('next-app', ['next in dependencies', dirEvidence(facts, 'app')])
    if (pagesDir) return build('next-pages', ['next in dependencies', dirEvidence(facts, 'pages')])
    // `next` with neither directory yet — a freshly created app. App Router is
    // the default for `create-next-app`, so scaffold into it.
    return build('next-app', ['next in dependencies'])
  }

  if (has('nuxt') || has('nuxt3')) {
    return build('nuxt', ['nuxt in dependencies', ...configEvidence(facts, 'nuxt.config')])
  }

  if (has('@sveltejs/kit')) {
    return build('sveltekit', [
      '@sveltejs/kit in dependencies',
      ...configEvidence(facts, 'svelte.config'),
    ])
  }

  if (has('astro')) {
    return build('astro', ['astro in dependencies', ...configEvidence(facts, 'astro.config')])
  }

  return build('static', ['No supported framework found in package.json'])
}

function dirEvidence(facts: ProjectFacts, name: string): string {
  return facts.files.has(`src/${name}`) ? `src/${name}/ directory` : `${name}/ directory`
}

function configEvidence(facts: ProjectFacts, base: string): string[] {
  const found = ['.ts', '.js', '.mjs'].map((ext) => `${base}${ext}`).find((f) => facts.files.has(f))
  return found === undefined ? [] : [found]
}

async function readProject(cwd: string): Promise<ProjectFacts> {
  const packageJson = await readJson(resolve(cwd, 'package.json'))
  const dependencies: Record<string, string> = {
    ...asRecord(packageJson?.['dependencies']),
    ...asRecord(packageJson?.['devDependencies']),
  }

  const candidates = [
    'app',
    'src/app',
    'pages',
    'src/pages',
    'src/routes',
    'server',
    'public',
    'static',
    'tsconfig.json',
    'jsconfig.json',
    'next.config.ts',
    'next.config.js',
    'next.config.mjs',
    'nuxt.config.ts',
    'nuxt.config.js',
    'svelte.config.js',
    'svelte.config.ts',
    'astro.config.ts',
    'astro.config.mjs',
    'astro.config.js',
    'src',
    'index.html',
  ]

  const present = await Promise.all(
    candidates.map(async (path) => ((await exists(resolve(cwd, path))) ? path : null)),
  )
  const files = new Set(present.filter((path): path is string => path !== null))

  return {
    dependencies,
    files,
    typescript: files.has('tsconfig.json'),
    srcDir: files.has('src'),
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  return value as Record<string, string>
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
