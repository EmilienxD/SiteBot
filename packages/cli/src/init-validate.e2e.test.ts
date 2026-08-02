/**
 * The Phase 9 acceptance criterion, as far as CI can take it: a scaffolded
 * project must validate under `sitebot validate` with one API key and no hand
 * edits. The live-network second half — `sitebot dev` actually answering a
 * chat — is the timed, recorded manual run the docs ask for
 * (docs/09 §Phase 9); CI never touches a provider.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from './commands/init.js'
import { runValidate } from './commands/validate.js'
import { Ui } from './terminal.js'
import type { CommandContext } from './commands/context.js'

let cwd: string
let previousKey: string | undefined

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'sitebot-e2e-'))
  // loadConfig reads process.env directly; the CommandContext.env is for the
  // command's own checks. The test sets both so they cannot disagree.
  previousKey = process.env['ANTHROPIC_API_KEY']
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key-with-enough-length'
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'demo-site', dependencies: { next: '15.0.0' } }),
  )
  await mkdir(join(cwd, 'app'), { recursive: true })
  await writeFile(join(cwd, 'tsconfig.json'), '{}')
})

afterEach(async () => {
  if (previousKey === undefined) delete process.env['ANTHROPIC_API_KEY']
  else process.env['ANTHROPIC_API_KEY'] = previousKey
  await rm(cwd, { recursive: true, force: true })
})

function context(overrides: Partial<CommandContext> = {}): CommandContext & { out: () => string; err: () => string } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    ui: new Ui({ color: false, write: (t) => lines.push(t), writeError: (t) => errors.push(t) }),
    out: () => lines.join(''),
    err: () => errors.join(''),
    cwd,
    flags: {},
    positionals: [],
    env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-with-enough-length' },
    answers: [],
    ...overrides,
  }
}

describe('init → validate, fresh Next.js app', () => {
  it('produces a config that validates with only the API key set', async () => {
    const init = context({ flags: { yes: true, 'skip-draft': true } })
    expect((await runInit(init)).exitCode).toBe(0)

    // No hand edits — read the file the scaffold wrote, verbatim.
    await readFile(join(cwd, 'chatbot.config.yaml'), 'utf8')

    const validate = context()
    const result = await runValidate(validate)
    if (result.exitCode !== 0) {
      console.log('STDOUT:', validate.out())
      console.log('STDERR:', validate.err())
    }
    expect(result.exitCode).toBe(0)
    expect(validate.out()).toContain('chatbot.config.yaml')
    expect(validate.out()).toContain('Resolved config')
    // The resolved view makes defaults explicit — a missing key would report
    // provider '' here instead of failing validation outright.
    expect(validate.out()).toContain('provider: anthropic')
    expect(validate.out()).toContain('apiKey: ***')
  }, 30_000)
})
