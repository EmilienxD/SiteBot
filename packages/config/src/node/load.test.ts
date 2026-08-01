import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigLoadError, ConfigValidationError } from '../index.js'
import { findConfigFile, loadConfig, loadConfigWithWarnings } from './index.js'

/** Node gained default TypeScript stripping in 22.18; skip there if absent. */
const canRunTypeScript = Boolean((process.features as { typescript?: unknown }).typescript)

const projects: string[] = []

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sitebot-config-'))
  projects.push(dir)
  // A real project has one; without it Node treats a bare .ts file as CommonJS.
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }')
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents)
  }
  return dir
}

afterEach(() => {
  for (const dir of projects.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const MINIMAL_YAML = `
version: 1
name: Acme
backend:
  provider: anthropic
  model: claude-opus-5
prompt:
  system: You are a helpful assistant.
`

describe('file resolution (docs/02 §1)', () => {
  it('finds chatbot.config.yaml', async () => {
    const dir = project({ 'chatbot.config.yaml': MINIMAL_YAML })
    const config = await loadConfig(undefined, { cwd: dir, env: {} })
    expect(config.name).toBe('Acme')
    expect(config.$meta.sourcePath).toBe(join(dir, 'chatbot.config.yaml'))
    expect(config.$meta.baseDir).toBe(dir)
  })

  it('prefers a code config over a declarative one', async () => {
    const dir = project({
      'chatbot.config.yaml': MINIMAL_YAML,
      'chatbot.config.mjs': `export default ${JSON.stringify({
        version: 1,
        name: 'From MJS',
        backend: { provider: 'anthropic', model: 'claude-opus-5' },
        prompt: { system: 'hi' },
      })}`,
    })
    const found = await findConfigFile(dir)
    expect(found).toBe(join(dir, 'chatbot.config.mjs'))

    const config = await loadConfig(undefined, { cwd: dir, env: {} })
    expect(config.name).toBe('From MJS')
  })

  it('prefers yaml over json over toml', async () => {
    const both = project({
      'chatbot.config.json': '{}',
      'chatbot.config.toml': '',
      'chatbot.config.yaml': MINIMAL_YAML,
    })
    expect(await findConfigFile(both)).toBe(join(both, 'chatbot.config.yaml'))

    const jsonAndToml = project({
      'chatbot.config.toml': '',
      'chatbot.config.json': '{}',
    })
    expect(await findConfigFile(jsonAndToml)).toBe(join(jsonAndToml, 'chatbot.config.json'))
  })

  it('falls back to the sitebot key in package.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sitebot-config-'))
    projects.push(dir)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        type: 'module',
        sitebot: {
          version: 1,
          name: 'From package.json',
          backend: { provider: 'anthropic', model: 'claude-opus-5' },
          prompt: { system: 'hi' },
        },
      }),
    )

    const config = await loadConfig(undefined, { cwd: dir, env: {} })
    expect(config.name).toBe('From package.json')
  })

  it('explains itself when there is no config at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sitebot-config-'))
    projects.push(dir)
    await expect(loadConfig(undefined, { cwd: dir })).rejects.toThrow(ConfigLoadError)
    await expect(loadConfig(undefined, { cwd: dir })).rejects.toThrow(/No SiteBot config found/)
  })

  it('accepts an explicit path', async () => {
    const dir = project({ 'custom.yaml': MINIMAL_YAML })
    const config = await loadConfig('custom.yaml', { cwd: dir, env: {} })
    expect(config.name).toBe('Acme')
  })

  it('accepts an object with no filesystem involved', async () => {
    const config = await loadConfig(
      {
        version: 1,
        name: 'Inline',
        backend: { provider: 'anthropic', model: 'claude-opus-5' },
        prompt: { system: 'hi' },
      },
      { env: {} },
    )
    expect(config.name).toBe('Inline')
    expect(config.$meta.sourcePath).toBeNull()
  })
})

describe('parsers', () => {
  it('reads JSON', async () => {
    const dir = project({
      'chatbot.config.json': JSON.stringify({
        version: 1,
        name: 'From JSON',
        backend: { provider: 'anthropic', model: 'claude-opus-5' },
        prompt: { system: 'hi' },
      }),
    })
    expect((await loadConfig(undefined, { cwd: dir, env: {} })).name).toBe('From JSON')
  })

  it('reads TOML', async () => {
    const dir = project({
      'chatbot.config.toml': [
        'version = 1',
        'name = "From TOML"',
        '[backend]',
        'provider = "anthropic"',
        'model = "claude-opus-5"',
        '[prompt]',
        'system = "hi"',
      ].join('\n'),
    })
    expect((await loadConfig(undefined, { cwd: dir, env: {} })).name).toBe('From TOML')
  })

  it.runIf(canRunTypeScript)('reads TypeScript', async () => {
    const dir = project({
      'chatbot.config.ts': [
        'interface Shape { version: 1; name: string }',
        'const config = {',
        '  version: 1 as const,',
        "  name: 'From TS' satisfies string,",
        "  backend: { provider: 'anthropic', model: 'claude-opus-5' },",
        "  prompt: { system: 'hi' },",
        '}',
        'export default config satisfies Partial<Shape>',
      ].join('\n'),
    })
    expect((await loadConfig(undefined, { cwd: dir, env: {} })).name).toBe('From TS')
  })

  it('reports a syntax error against the file', async () => {
    const dir = project({ 'chatbot.config.yaml': 'name: [unclosed' })
    await expect(loadConfig(undefined, { cwd: dir })).rejects.toThrow(/is not valid YAML/)
  })
})

describe('extends (docs/02 §1)', () => {
  it('layers a code config over a declarative one', async () => {
    const dir = project({
      'chatbot.config.yaml': `${MINIMAL_YAML}
mode: agent
storage:
  type: memory
tools:
  - name: quote
    description: Quote from the YAML file.
    executor:
      type: http
      url: https://api.acme.com/quote
  - name: lookup
    description: Look something up.
    readOnly: true
    executor:
      type: client
      id: read_element
`,
      'chatbot.config.mjs': `export default {
        extends: './chatbot.config.yaml',
        name: 'Overridden',
        tools: [
          { name: 'quote', description: 'Quote from the TS file.', executor: { type: 'client', id: 'quote' } },
          { name: 'extra', description: 'A brand new tool.', executor: { type: 'client', id: 'extra' } },
        ],
      }`,
    })

    const config = await loadConfig(undefined, { cwd: dir, env: {} })

    expect(config.name).toBe('Overridden')
    expect(config.mode).toBe('agent')
    expect(config.$meta.extendsChain).toEqual([join(dir, 'chatbot.config.yaml')])

    const names = config.tools.map((tool) => ('name' in tool ? tool.name : `mcp:${tool.id}`))
    expect(names).toEqual(['quote', 'lookup', 'extra'])

    const quote = config.tools[0]
    expect(quote && 'executor' in quote && quote.executor?.type).toBe('client')
  })

  it('applies an array of parents left to right', async () => {
    const dir = project({
      'base.yaml': MINIMAL_YAML,
      'brand.yaml': 'name: Branded\nui:\n  theme:\n    primary: "#ff0000"\n',
      'chatbot.config.mjs': `export default {
        extends: ['./base.yaml', './brand.yaml'],
      }`,
    })

    const config = await loadConfig(undefined, { cwd: dir, env: {} })
    expect(config.name).toBe('Branded')
    expect(config.ui.theme.primary).toBe('#ff0000')
    expect(config.$meta.extendsChain).toEqual([join(dir, 'base.yaml'), join(dir, 'brand.yaml')])
  })

  it('concatenates knowledge sources across the chain', async () => {
    const dir = project({
      'base.yaml': `${MINIMAL_YAML}
knowledge:
  embedding:
    provider: openai
    model: text-embedding-3-small
  sources:
    - type: text
      id: from_base
      content: base content
`,
      'chatbot.config.mjs': `export default {
        extends: './base.yaml',
        knowledge: { sources: [{ type: 'text', id: 'from_ts', content: 'ts content' }] },
      }`,
    })

    const config = await loadConfig(undefined, { cwd: dir, env: {} })
    expect(config.knowledge.sources.map((source) => source.id)).toEqual(['from_base', 'from_ts'])
  })

  it('refuses a circular chain', async () => {
    const dir = project({
      'a.yaml': 'extends: ./b.yaml\nname: A\n',
      'b.yaml': 'extends: ./a.yaml\nname: B\n',
      'chatbot.config.yaml': `extends: ./a.yaml\n${MINIMAL_YAML}`,
    })
    await expect(loadConfig(undefined, { cwd: dir })).rejects.toThrow(/Circular `extends`/)
  })

  it('names a parent it cannot find', async () => {
    const dir = project({
      'chatbot.config.yaml': `extends: ./nope.yaml\n${MINIMAL_YAML}`,
    })
    await expect(loadConfig(undefined, { cwd: dir })).rejects.toThrow(/Extended config not found/)
  })
})

describe('prompt.systemFile', () => {
  it('is read into prompt.system at load time', async () => {
    const dir = project({
      'chatbot.config.yaml': `
version: 1
name: Acme
backend:
  provider: anthropic
  model: claude-opus-5
prompt:
  systemFile: ./system.md
`,
      'system.md': 'You are the Acme assistant.',
    })

    const config = await loadConfig(undefined, { cwd: dir, env: {} })
    expect(config.prompt.system).toBe('You are the Acme assistant.')
    expect(config.prompt).not.toHaveProperty('systemFile')
  })

  it('says where it looked when the file is missing', async () => {
    const dir = project({
      'chatbot.config.yaml': `
version: 1
name: Acme
backend:
  provider: anthropic
  model: claude-opus-5
prompt:
  systemFile: ./missing.md
`,
    })
    await expect(loadConfig(undefined, { cwd: dir })).rejects.toThrow(
      /Could not read prompt.systemFile/,
    )
  })
})

describe('the environment', () => {
  it('throws a formatted ConfigValidationError for a missing variable', async () => {
    const dir = project({
      'chatbot.config.yaml': `${MINIMAL_YAML}
security:
  auth:
    mode: required
    jwt:
      secret: \${env.SITEBOT_JWT_SECRET}
`,
    })

    const error = await loadConfig(undefined, { cwd: dir, env: {} }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ConfigValidationError)
    const validation = error as ConfigValidationError
    expect(validation.errors[0]?.rule).toBe('env/missing-variable')
    expect(validation.message).toContain('SITEBOT_JWT_SECRET')
    expect(validation.message).toContain('chatbot.config.yaml')
  })

  it('reads .env and .env.local when asked, with the process winning', async () => {
    const dir = project({
      'chatbot.config.yaml': `${MINIMAL_YAML}
security:
  publicKey: \${env.FROM_ENV_FILE}
telemetry:
  events:
    webhook: \${env.FROM_LOCAL}
`,
      '.env': 'FROM_ENV_FILE=base\nFROM_LOCAL=base\n',
      '.env.local': 'FROM_LOCAL=local\n',
    })

    const config = await loadConfig(undefined, { cwd: dir, dotenv: true })
    expect(config.security.publicKey).toBe('base')
    expect(config.telemetry.events.webhook).toBe('local')
  })

  it('does not read .env unless asked', async () => {
    const dir = project({
      'chatbot.config.yaml': `${MINIMAL_YAML}
security:
  publicKey: \${env.FROM_ENV_FILE}
`,
      '.env': 'FROM_ENV_FILE=base\n',
    })
    await expect(loadConfig(undefined, { cwd: dir, env: {} })).rejects.toThrow(
      /FROM_ENV_FILE is not set/,
    )
  })
})

describe('warnings', () => {
  it('surfaces them without failing the load', async () => {
    const dir = project({
      'chatbot.config.yaml': `${MINIMAL_YAML}
mode: agent
tools:
  - from: mcp
    id: acme
    server:
      transport: http
      url: https://acme.com/mcp
`,
    })

    const { config, warnings } = await loadConfigWithWarnings(undefined, {
      cwd: dir,
      env: {},
    })
    expect(config.mode).toBe('agent')
    expect(warnings.map((warning) => warning.rule)).toContain('tools/mcp-allow-missing')
  })
})
