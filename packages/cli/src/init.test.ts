import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from './commands/init.js'
import { Ui } from './terminal.js'
import type { CommandContext } from './commands/context.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'sitebot-init-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function capture() {
  const lines: string[] = []
  const errors: string[] = []
  const ui = new Ui({ color: false, write: (text) => lines.push(text), writeError: (text) => errors.push(text) })
  return { ui, lines: lines, errors, text: () => lines.join(''), errText: () => errors.join('') }
}

function context(overrides: Partial<CommandContext> = {}): CommandContext & { output: ReturnType<typeof capture> } {
  const output = capture()
  return {
    output,
    ui: output.ui,
    cwd,
    flags: {},
    positionals: [],
    env: {},
    answers: [],
    ...overrides,
  }
}

async function makeNextApp(): Promise<void> {
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { next: '15.0.0' } }),
  )
  await mkdir(join(cwd, 'app'), { recursive: true })
  await writeFile(join(cwd, 'tsconfig.json'), '{}')
}

describe('sitebot init', () => {
  it('scaffolds a config and App Router catch-all route on a fresh Next.js app', async () => {
    await makeNextApp()

    const ctx = context({
      flags: { yes: true, 'skip-draft': true, provider: 'anthropic' },
    })
    const result = await runInit(ctx)

    expect(result.exitCode).toBe(0)

    const config = await readFile(join(cwd, 'chatbot.config.yaml'), 'utf8')
    // The $schema line is what gives the developer autocomplete (docs/02 §14).
    expect(config).toContain('yaml-language-server: $schema=')
    expect(config).toContain('provider: anthropic')
    expect(config).toContain('apiKey: ${env.ANTHROPIC_API_KEY}')
    expect(config).toContain('mode: chat')

    const route = await readFile(join(cwd, 'app/api/chat/[[...route]]/route.ts'), 'utf8')
    expect(route).toContain("export const runtime = 'nodejs'")
    expect(route).toContain('@sitebot/server/next')

    const envExample = await readFile(join(cwd, '.env.example'), 'utf8')
    expect(envExample).toContain('ANTHROPIC_API_KEY=')

    const nextSteps = ctx.output.text()
    expect(nextSteps).toContain('npm i')
    expect(nextSteps).toContain('data-endpoint="/api/chat"')
  })

  it('refuses to overwrite an existing config without --force', async () => {
    await makeNextApp()
    await writeFile(join(cwd, 'chatbot.config.yaml'), 'version: 1\n')

    const ctx = context({ flags: { yes: true, 'skip-draft': true } })
    const result = await runInit(ctx)

    expect(result.exitCode).toBe(1)
    expect(ctx.output.errText()).toContain('already exists')

    const untouched = await readFile(join(cwd, 'chatbot.config.yaml'), 'utf8')
    expect(untouched).toBe('version: 1\n')
  })

  it('writes nothing on --dry-run', async () => {
    await makeNextApp()
    const ctx = context({ flags: { yes: true, 'skip-draft': true, 'dry-run': true } })
    const result = await runInit(ctx)

    expect(result.exitCode).toBe(0)
    expect(ctx.output.text()).toContain('--dry-run')
    await expect(readFile(join(cwd, 'chatbot.config.yaml'), 'utf8')).rejects.toThrow()
  })

  it('writes no route file for a static site and points at the sidecar', async () => {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'plain' }))
    const ctx = context({ flags: { yes: true, 'skip-draft': true } })
    const result = await runInit(ctx)

    expect(result.exitCode).toBe(0)
    await expect(
      readFile(join(cwd, 'chatbot.config.yaml'), 'utf8'),
    ).resolves.toContain('mode: chat')
    expect(ctx.output.text()).toContain('npx sitebot dev')
  })

  it('adds .env files to .gitignore when present', async () => {
    await makeNextApp()
    await writeFile(join(cwd, '.gitignore'), 'node_modules\n')

    const ctx = context({ flags: { yes: true, 'skip-draft': true } })
    await runInit(ctx)

    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toContain('.env.local')
  })

  it('rejects an unknown --framework', async () => {
    await makeNextApp()
    const ctx = context({ flags: { yes: true, framework: 'rails' } })
    const result = await runInit(ctx)
    expect(result.exitCode).toBe(1)
    expect(ctx.output.errText()).toContain('Unknown framework')
  })
})
