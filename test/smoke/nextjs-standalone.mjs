#!/usr/bin/env node
// Exercise the deployable bundle in a temporary directory, away from the repo.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appArgument = process.argv.indexOf('--app')
const app = appArgument < 0 ? join(root, 'examples/nextjs') : resolve(process.argv[appArgument + 1])
const appRelative = relative(root, app)
assert(
  appRelative && !appRelative.startsWith('..') && !isAbsolute(appRelative),
  'Smoke app must be inside this workspace',
)
const deployment = await mkdtemp(join(tmpdir(), 'sitebot-next-standalone-'))
const deployedApp = join(deployment, appRelative)
let server
let log = ''

try {
  // Node's cp does not preserve directory-symlink type on Windows. Copy the
  // files first, then recreate each link with its actual type.
  const links = []
  await cp(join(app, '.next/standalone'), deployment, {
    recursive: true,
    filter: async (source, destination) => {
      if (!(await lstat(source)).isSymbolicLink()) return true
      links.push({
        destination,
        target: await readlink(source),
        directory: (await stat(source)).isDirectory(),
      })
      return false
    },
  })
  for (const { destination, target, directory } of links) {
    await symlink(target, destination, directory ? 'dir' : 'file')
  }
  await cp(join(app, '.next/static'), join(deployedApp, '.next/static'), { recursive: true })
  // Test-only runtime inputs; production ships the real YAML config.
  await cp(join(root, 'e2e/fixtures/scripted-model.mjs'), join(deployedApp, 'scripted-model.mjs'))
  await writeFile(
    join(deployedApp, 'smoke.config.mjs'),
    "export default { extends: './chatbot.config.yaml', backend: { provider: 'custom', model: 'scripted', module: './scripted-model.mjs#createModel' } }",
  )
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const { port } = socket.address()
  await new Promise((resolve) => socket.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [join(deployedApp, 'server.js')], {
    cwd: deployedApp,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC'].includes(key.toUpperCase()),
        ),
      ),
      NEXT_TELEMETRY_DISABLED: '1',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      OPENAI_API_KEY: 'sk-offline-dummy',
      SITEBOT_CONFIG: './smoke.config.mjs',
      SITE_URL: origin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  server.stdout.on('data', (data) => (log += data))
  server.stderr.on('data', (data) => (log += data))
  const smoke = spawn(
    process.execPath,
    [
      join(root, 'test/smoke/smoke.mjs'),
      '--endpoint',
      `${origin}/api/chat`,
      '--tool',
      'find_service_slots {"date":"2026-09-28"}',
      '--expect',
      '"slots"',
      '--timeout',
      '30',
    ],
    { stdio: 'inherit', windowsHide: true },
  )
  assert.equal((await once(smoke, 'exit'))[0], 0, log)
  for (const route of ['/', '/bikes', '/service', '/sitemap.xml']) {
    const response = await fetch(`${origin}${route}`)
    assert.equal(response.status, 200, route)
    const body = await response.text()
    assert(body.includes('Lumen') || route === '/sitemap.xml')
    if (route === '/') {
      for (const [, asset] of body.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css))"/g)) {
        if (asset.startsWith('/_next/')) {
          assert.equal((await fetch(`${origin}${asset}`)).status, 200, asset)
        }
      }
    }
    process.stdout.write(`Production page: ${route} 200\n`)
  }
  assert((await readFile(join(deployedApp, 'chatbot.config.yaml'), 'utf8')).includes('Lumen Bikes'))
  process.stdout.write('Copied standalone deployment smoke passed.\n')
  const closed = once(server, 'exit')
  server.kill()
  await closed
  if (process.argv.includes('--qa')) {
    const { verifyNextQa } = await import('./nextjs-qa.mjs')
    await verifyNextQa(deployedApp, deployment)
  }
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = once(server, 'exit')
    server.kill()
    await closed
  }
  assert.equal(dirname(resolve(deployment)), resolve(tmpdir()))
  assert(deployment.includes('sitebot-next-standalone-'))
  await rm(deployment, { recursive: true, force: true })
}
