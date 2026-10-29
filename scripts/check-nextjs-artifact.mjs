#!/usr/bin/env node
// Inspect actual production traces rather than the build cache. Run after build.
import assert from 'node:assert/strict'
import { readdir, readFile, readlink, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appArgument = process.argv.indexOf('--app')
const app =
  appArgument < 0 ? resolve(root, 'examples/nextjs') : resolve(process.argv[appArgument + 1])
const appPath = relative(root, app).replaceAll('\\', '/')
assert(
  appPath && !appPath.startsWith('..') && !isAbsolute(appPath),
  'Artifact app must be inside this workspace',
)
const build = resolve(app, '.next')
const normalize = (path) => path.replaceAll('\\', '/')

async function walk(dir, artifactRoot = dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name)
      // pnpm aliases point at files already counted in the deployed .pnpm tree.
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(path), await readlink(path))
        const rel = relative(artifactRoot, target)
        assert(
          rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
          `External artifact link: ${path}`,
        )
        await stat(target)
        return []
      }
      return entry.isDirectory() ? walk(path, artifactRoot) : [path]
    }),
  )
  return files.flat()
}

async function summarize(label, files) {
  const sizes = await Promise.all([...files].map(async (file) => (await stat(file)).size))
  const bytes = sizes.reduce((total, size) => total + size, 0)
  console.log(
    `${label}: ${sizes.length} files, ${bytes} bytes (${(bytes / 1024 ** 2).toFixed(2)} MiB)`,
  )
}

const traces = (await walk(resolve(build, 'server'))).filter((file) => file.endsWith('.nft.json'))
traces.push(
  resolve(build, 'next-server.js.nft.json'),
  resolve(build, 'next-minimal-server.js.nft.json'),
)
const all = new Set()
const chatTrace = resolve(build, 'server/app/api/chat/[[...route]]/route.js.nft.json')
assert(traces.includes(chatTrace), 'Chat route trace missing')
for (const trace of traces) {
  const { files } = JSON.parse(await readFile(trace, 'utf8'))
  const resolved = new Set(files.map((file) => resolve(dirname(trace), file)))
  for (const file of resolved) {
    const path = normalize(relative(root, file))
    const permitted =
      path.includes('/node_modules/') ||
      path.startsWith('node_modules/') ||
      path.startsWith(`${appPath}/.next/`) ||
      /^packages\/[^/]+\/(dist\/|package\.json$|pricing\.json$)/.test(path) ||
      [
        `${appPath}/package.json`,
        `${appPath}/chatbot.config.yaml`,
        `${appPath}/.sitebot/index.json`,
      ].includes(path)
    assert(permitted, `Unexpected application file in ${relative(build, trace)}: ${path}`)
    all.add(file)
  }
  if (trace === chatTrace) {
    assert(resolved.has(resolve(app, 'chatbot.config.yaml')), 'Chat config missing from trace')
    if (process.argv.includes('--expect-index')) {
      assert(
        resolved.has(resolve(app, '.sitebot/index.json')),
        'Prebuilt knowledge index missing from trace',
      )
    }
    await summarize('Chat route dependencies', resolved)
  }
}
await summarize('Unique traced dependencies', all)
const standalone = resolve(build, 'standalone')
const deployedApp = resolve(standalone, relative(root, app))
await stat(resolve(deployedApp, 'server.js'))
await stat(resolve(deployedApp, 'chatbot.config.yaml'))
const sdk = createRequire(resolve(deployedApp, 'runtime.cjs')).resolve(
  '@ai-sdk/openai/package.json',
)
const sdkPath = relative(standalone, sdk)
assert(
  !isAbsolute(sdkPath) && sdkPath !== '..' && !sdkPath.startsWith(`..${sep}`),
  'Provider SDK escaped the standalone artifact',
)
await stat(sdk)
const sdkMetadata = JSON.parse(await readFile(sdk, 'utf8'))
await stat(resolve(dirname(sdk), sdkMetadata.exports['.'].import))
if (process.argv.includes('--expect-index')) {
  const snapshotPath = '.sitebot/index.json'
  assert.equal(
    await readFile(resolve(deployedApp, snapshotPath), 'utf8'),
    await readFile(resolve(app, snapshotPath), 'utf8'),
    'Traced snapshot bytes changed',
  )
}
await summarize('Standalone server (without static assets)', await walk(standalone))
await summarize('Static assets', await walk(resolve(build, 'static')))
console.log(
  'Artifact check passed: runtime inputs included; application sources and unrelated workspace files excluded.',
)
