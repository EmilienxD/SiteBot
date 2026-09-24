import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { emitJsonSchema, validateConfig } from '@sitebot/config'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script with no type declarations.
import { renderConfigReference } from '../scripts/config-reference.mjs'

const DOCS = join(import.meta.dirname, '..')
const REPO = join(DOCS, '..', '..')
const read = (path: string) => readFileSync(path, 'utf8')

/** Every `${env.X}` resolves, so the recipes validate without real secrets. */
const anyEnv = new Proxy({} as Record<string, string>, {
  get: (_target, name) => (typeof name === 'string' ? `test-${name.toLowerCase()}` : undefined),
  has: () => true,
})

describe('recipes', () => {
  const pages = readdirSync(join(DOCS, 'recipes')).filter(
    (file) => file.endsWith('.md') && file !== 'index.md',
  )

  it('has the four recipes the plan calls for', () => {
    expect(pages.sort()).toEqual([
      'docs-assistant.md',
      'ecommerce.md',
      'lead-capture.md',
      'support-triage.md',
    ])
  })

  it.each(pages)('%s carries one complete config that validates', (page) => {
    const blocks = [
      ...read(join(DOCS, 'recipes', page)).matchAll(/```yaml \[chatbot\.config\.yaml\]\n([\s\S]*?)```/g),
    ]
    expect(blocks, 'expected exactly one ```yaml [chatbot.config.yaml] block').toHaveLength(1)
    const result = validateConfig(parse(blocks[0]![1]!), { env: anyEnv })
    expect(result.ok ? [] : result.errors).toEqual([])
  })
})

describe('troubleshooting', () => {
  const page = read(join(DOCS, 'guide', 'troubleshooting.md'))
  const headings = new Set(
    [...page.matchAll(/^### `([^`]+)`/gm)].map((match) => match[1]!.replace(/ <[^>]+>$/, '')),
  )

  it('has an entry for every check `sitebot doctor` can print', () => {
    const doctor = read(join(REPO, 'packages', 'cli', 'src', 'commands', 'doctor.ts'))
    const fixed = [...doctor.matchAll(/name: '([^']+)'/g)].map((match) => match[1]!)
    // `name: \`env ${variable}\`` → the heading `env <VARIABLE>`.
    const templated = [...doctor.matchAll(/name: `(\w+) \$\{/g)].map((match) => match[1]!)
    expect(fixed.length + templated.length).toBeGreaterThan(10)
    for (const name of fixed) expect(headings, `no entry for "${name}"`).toContain(name)
    for (const prefix of templated)
      expect(
        [...headings].some((heading) => heading.startsWith(`${prefix} `)),
        `no entry for "${prefix} …"`,
      ).toBe(true)
  })

  it('has an entry for every `doctor --production` check', () => {
    const production = read(join(REPO, 'packages', 'cli', 'src', 'index.ts'))
    const labels = [...production.matchAll(/(?:add|manual)\(\s*'([^']+)'/g)].map((m) => m[1]!)
    expect(labels.length).toBeGreaterThan(10)
    for (const label of labels) expect(headings, `no entry for "${label}"`).toContain(label)
  })
})

describe('config reference', () => {
  it('is up to date with the schema', () => {
    const committed = read(join(DOCS, 'reference', 'configuration.md'))
    expect(
      committed === renderConfigReference(emitJsonSchema()),
      'reference/configuration.md is stale — run `pnpm --filter @sitebot/docs reference`',
    ).toBe(true)
  })

  it('documents every top-level key and every storage type', () => {
    const page = read(join(DOCS, 'reference', 'configuration.md'))
    const schema = emitJsonSchema() as { properties: Record<string, unknown> }
    for (const key of Object.keys(schema.properties)) expect(page).toContain(`## \`${key}\``)
    for (const type of ['none', 'memory', 'sqlite', 'redis', 'postgres', 'custom'])
      expect(page).toContain(`\`storage\` — \`type: ${type}\``)
  })
})
