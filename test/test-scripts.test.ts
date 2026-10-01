import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import config from '../vitest.config.js'

/**
 * `pnpm test` names its projects one by one: vitest ORs repeated
 * `--project=!x` filters, so `!live` would let `live` back in through
 * `!security-*`, and `test:live` makes real provider calls (docs/04 §10).
 * This keeps the list complete when a project is added.
 */
it('pnpm test runs every project except the opt-in live and security suites', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const scripts = (
    JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts
  const projects = (config.test?.projects as { test: { name: string } }[]).map(
    (project) => project.test.name,
  )
  const expected = projects.filter((name) => name !== 'live' && !name.startsWith('security-'))
  for (const script of ['test', 'test:watch']) {
    const selected = [...scripts[script]!.matchAll(/--project=(\S+)/g)].map((match) => match[1])
    expect(selected.sort(), script).toEqual([...expected].sort())
  }
})
