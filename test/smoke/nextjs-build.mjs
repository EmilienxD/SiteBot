#!/usr/bin/env node
// Keyless production build in an isolated copy, with synthetic indexed public
// evidence present before tracing. No dotenv files or new dependencies.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { knowledgeSnapshot } from './nextjs-provider.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const original = join(root, 'examples/nextjs')
const parent = join(root, '.sitebot')
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(join(parent, 'next-runtime-'))
const app = join(directory, 'app')
try {
  await mkdir(app)
  for (const input of [
    'app',
    'lib',
    'scripts',
    'package.json',
    'chatbot.config.yaml',
    'tsconfig.json',
  ])
    await cp(join(original, input), join(app, input), { recursive: true })
  const importPath = relative(app, join(original, 'next.config')).replaceAll('\\', '/')
  await writeFile(
    join(app, 'next.config.ts'),
    `import original from '${importPath}'\nexport default { ...original, outputFileTracingRoot: ${JSON.stringify(root)} }\n`,
  )
  const typescript = JSON.parse(await readFile(join(app, 'tsconfig.json'), 'utf8'))
  typescript.extends = relative(app, join(root, 'tsconfig.base.json')).replaceAll('\\', '/')
  await writeFile(join(app, 'tsconfig.json'), JSON.stringify(typescript))
  // This link is for the build only. Artifact checks require runtime links
  // to point inside the resulting deployment; no source link is shipped.
  async function linkDependencies(source, target) {
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@') && entry.isDirectory())
        await linkDependencies(join(source, entry.name), join(target, entry.name))
      else
        await symlink(
          await realpath(join(source, entry.name)),
          join(target, entry.name),
          process.platform === 'win32' ? 'junction' : 'dir',
        )
    }
  }
  await linkDependencies(join(original, 'node_modules'), join(app, 'node_modules'))
  if (process.env.SITEBOT_LIVE_NEXT_STORES === '1') {
    // Test-only selected optional client, declared exactly as an operator's
    // Postgres deployment must do. No store credentials enter the build.
    await symlink(
      await realpath(join(root, 'packages/core/node_modules/pg')),
      join(app, 'node_modules/pg'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const sitebot = join(app, 'lib/sitebot.ts')
    await writeFile(sitebot, `import 'pg'\n${await readFile(sitebot, 'utf8')}`)
    await writeFile(
      join(app, 'next.config.ts'),
      `import original from '${importPath}'\nexport default { ...original, serverExternalPackages: [...(original.serverExternalPackages ?? []), 'pg'], outputFileTracingRoot: ${JSON.stringify(root)} }\n`,
    )
  }
  await mkdir(join(app, '.sitebot'))
  await writeFile(join(app, '.sitebot/index.json'), JSON.stringify(knowledgeSnapshot()))
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC'].includes(key.toUpperCase()),
    ),
  )
  const env = { ...environment, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' }
  async function run(script, args = [], cwd = app, extraEnv = {}) {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: 'inherit',
      windowsHide: true,
    })
    assert.equal((await once(child, 'exit'))[0], 0, `Production build/check failed: ${script}`)
  }
  await run(join(original, 'node_modules/next/dist/bin/next'), ['build'])
  await run(join(app, 'scripts/prepare-standalone.mjs'))
  await run(join(root, 'scripts/check-nextjs-artifact.mjs'), ['--app', app, '--expect-index'], root)
  process.stdout.write(
    'Isolated production build: no provider keys or dotenv files; synthetic snapshot included by tracing.\n',
  )
  const storeEnv =
    process.env.SITEBOT_LIVE_NEXT_STORES === '1'
      ? {
          SITEBOT_LIVE_NEXT_STORES: '1',
          SITEBOT_LIVE_REDIS_URL: process.env.SITEBOT_LIVE_REDIS_URL,
          SITEBOT_LIVE_PG_URL: process.env.SITEBOT_LIVE_PG_URL,
        }
      : {}
  await run(join(root, 'test/smoke/nextjs-standalone.mjs'), ['--app', app, '--qa'], root, storeEnv)
} finally {
  assert.equal(dirname(resolve(directory)), resolve(parent))
  assert(relative(parent, directory).startsWith('next-runtime-'))
  await rm(directory, { recursive: true, force: true })
}
