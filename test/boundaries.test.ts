import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Executable proof of the dependency graph in docs/01-architecture.md §3.
 *
 * The layering is only real if it is enforced, and an architecture rule that
 * lives in prose gets violated the first time someone is in a hurry. Each case
 * below lints a snippet as if it were a file in the given package and asserts
 * whether the boundary rule fires.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let eslint: ESLint

beforeAll(async () => {
  eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: join(repoRoot, 'eslint.config.js'),
  })

  // ESLint loads the flat config, parser, and plugins lazily. Do that work in
  // the explicitly timed hook instead of charging it to whichever test runs
  // first.
  await eslint.lintText('', { filePath: join(repoRoot, 'packages/config/src/leak.ts') })
}, 15_000)

/** Lint `code` as if it lived at `filePath`, relative to the repo root. */
async function lint(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, filePath) })
  return result?.messages ?? []
}

const restricted = (messages: Awaited<ReturnType<typeof lint>>) =>
  messages.filter((m) => m.ruleId?.endsWith('no-restricted-imports'))

describe('dependency boundaries (docs/01 §3)', () => {
  it('rule 1: config may not import core', async () => {
    const messages = await lint(
      'packages/config/src/leak.ts',
      `import { MODES } from '@sitebot/core'\nexport const x = MODES\n`,
    )
    expect(restricted(messages)).toHaveLength(1)
  })

  it('rule 1: config may import third-party packages', async () => {
    const messages = await lint(
      'packages/config/src/ok.ts',
      `import { parse } from 'yaml'\nexport const x = parse\n`,
    )
    expect(restricted(messages)).toHaveLength(0)
  })

  it('rule 2: core may import config', async () => {
    const messages = await lint(
      'packages/core/src/ok.ts',
      `import { CONFIG_SCHEMA_VERSION } from '@sitebot/config'\nexport const x = CONFIG_SCHEMA_VERSION\n`,
    )
    expect(restricted(messages)).toHaveLength(0)
  })

  it('rule 2: core may not import server', async () => {
    const messages = await lint(
      'packages/core/src/leak.ts',
      `import { ROUTES } from '@sitebot/server'\nexport const x = ROUTES\n`,
    )
    expect(restricted(messages)).toHaveLength(1)
  })

  it("rule 4: widget may import config's types", async () => {
    const messages = await lint(
      'packages/widget/src/ok.ts',
      `import type { ConfigFilename } from '@sitebot/config'\nexport type X = ConfigFilename\n`,
    )
    expect(restricted(messages)).toHaveLength(0)
  })

  it('rule 4: widget may not import config at runtime', async () => {
    const messages = await lint(
      'packages/widget/src/leak.ts',
      `import { CONFIG_SCHEMA_VERSION } from '@sitebot/config'\nexport const x = CONFIG_SCHEMA_VERSION\n`,
    )
    expect(restricted(messages)).toHaveLength(1)
  })

  it('rule 4: widget may not import core at all', async () => {
    const messages = await lint(
      'packages/widget/src/leak2.ts',
      `import type { Mode } from '@sitebot/core'\nexport type X = Mode\n`,
    )
    expect(restricted(messages)).toHaveLength(1)
  })

  it('rule 5: nothing imports cli', async () => {
    const messages = await lint(
      'packages/server/src/leak.ts',
      `import { COMMANDS } from '@sitebot/cli'\nexport const x = COMMANDS\n`,
    )
    expect(restricted(messages)).toHaveLength(1)
  })

  it("rule 6: core's root entry may not import node:*", async () => {
    const messages = await lint(
      'packages/core/src/store.ts',
      `import { readFile } from 'node:fs/promises'\nexport const x = readFile\n`,
    )
    expect(restricted(messages)).toHaveLength(1)
  })

  it('rule 6: core/node may import node:*', async () => {
    const messages = await lint(
      'packages/core/src/node/store.ts',
      `import { readFile } from 'node:fs/promises'\nexport const x = readFile\n`,
    )
    expect(restricted(messages)).toHaveLength(0)
  })

  it("rule 6: config's root entry may not import node:* either", async () => {
    const messages = await lint(
      'packages/config/src/loader.ts',
      `import { readFile } from 'node:fs/promises'\nexport const x = readFile\n`,
    )
    expect(restricted(messages)).toHaveLength(1)
  })

  it('rule 6: config/node may import node:*', async () => {
    const messages = await lint(
      'packages/config/src/node/loader.ts',
      `import { readFile } from 'node:fs/promises'\nexport const x = readFile\n`,
    )
    expect(restricted(messages)).toHaveLength(0)
  })

  it('rule 7: no package reaches into another package internals', async () => {
    const messages = await lint(
      'packages/server/src/leak2.ts',
      `import { thing } from '@sitebot/core/src/agent/run'\nexport const x = thing\n`,
    )
    expect(restricted(messages)).toHaveLength(1)
  })
})

it('widget can import the dependency-free catalog subpath without importing the schema runtime', async () => {
  expect(
    restricted(
      await lint(
        'packages/widget/src/locale.ts',
        `import { resolveLocale } from '@sitebot/config/i18n'\nexport const locale = resolveLocale({})\n`,
      ),
    ),
  ).toHaveLength(0)
})
