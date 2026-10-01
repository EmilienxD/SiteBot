#!/usr/bin/env node
// Inspect actual production traces rather than the build cache. Run after build.
import assert from 'node:assert/strict'
import { readdir, readFile, readlink, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const app = resolve(root, 'examples/nextjs')
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
      path.startsWith('examples/nextjs/.next/') ||
      /^packages\/[^/]+\/(dist\/|package\.json$|pricing\.json$)/.test(path) ||
      [
        'examples/nextjs/package.json',
        'examples/nextjs/chatbot.config.yaml',
        'examples/nextjs/.sitebot/index.json',
      ].includes(path)
    assert(permitted, `Unexpected application file in ${relative(build, trace)}: ${path}`)
    all.add(file)
  }
  if (trace === chatTrace) {
    assert(resolved.has(resolve(app, 'chatbot.config.yaml')), 'Chat config missing from trace')
    await summarize('Chat route dependencies', resolved)
  }
}
await summarize('Unique traced dependencies', all)
const standalone = resolve(build, 'standalone')
await stat(resolve(standalone, 'examples/nextjs/server.js'))
await stat(resolve(standalone, 'examples/nextjs/chatbot.config.yaml'))
await summarize('Standalone server (without static assets)', await walk(standalone))
await summarize('Static assets', await walk(resolve(build, 'static')))
console.log(
  'Artifact check passed: runtime inputs included; application sources and unrelated workspace files excluded.',
)
