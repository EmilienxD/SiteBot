#!/usr/bin/env node
// Next preserves pnpm's absolute Windows links. Rebase them into the artifact
// so copying it to another machine does not retain references to this checkout.
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, readlink, stat, symlink, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(
  await readFile(resolve(app, '.next/required-server-files.json'), 'utf8'),
)
const root = resolve(manifest.config.outputFileTracingRoot ?? app)
const standalone = resolve(app, '.next/standalone')
let rebased = 0

function inside(base, path) {
  const rel = relative(base, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = resolve(dir, entry.name)
    if (entry.isSymbolicLink()) {
      const original = resolve(dirname(file), await readlink(file))
      if (inside(standalone, original)) continue
      assert(inside(root, original), `Dependency link outside workspace: ${file}`)
      const target = resolve(standalone, relative(root, original))
      // On Windows NFT can trace an alias without its destination (for
      // example sharp's semver dependency). Include that package as well.
      const info = await stat(target).catch(async (error) => {
        if (error.code !== 'ENOENT') throw error
        assert(original.includes(`${sep}node_modules${sep}`), `Missing traced input: ${original}`)
        await cp(original, target, { recursive: true, verbatimSymlinks: true })
        const copied = await stat(target)
        if (copied.isDirectory()) await visit(target)
        return copied
      })
      const link = relative(dirname(file), target)
      await unlink(file)
      try {
        await symlink(link, file, info.isDirectory() ? 'dir' : 'file')
      } catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
        throw new Error(
          'Portable standalone output needs Windows Developer Mode or permission to create symbolic links. Build on Linux as an alternative.',
          { cause: error },
        )
      }
      rebased += 1
    } else if (entry.isDirectory()) {
      await visit(file)
    }
  }
}

await visit(standalone)
// Turbopack gives external packages hashed aliases. SiteBot's optional SDK
// imports use their original names, so preserve those names as well. The
// server-only import must already have traced the package and its dependencies.
const require = createRequire(resolve(app, 'package.json'))
for (const name of manifest.config.serverExternalPackages ?? []) {
  let source = dirname(require.resolve(name))
  for (;;) {
    const metadata = await readFile(resolve(source, 'package.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    if (metadata?.name === name) break
    const parent = dirname(source)
    assert(parent !== source, `Cannot find external package root: ${name}`)
    source = parent
  }
  assert(inside(root, source), `External package outside workspace: ${name}`)
  const target = resolve(standalone, relative(root, source))
  await stat(target)
  const alias = resolve(standalone, relative(root, app), 'node_modules', name)
  if (
    await stat(alias)
      .then(() => true)
      .catch(() => false)
  )
    continue
  await mkdir(dirname(alias), { recursive: true })
  await symlink(relative(dirname(alias), target), alias, 'dir')
  rebased += 1
}
console.log(`Standalone dependencies prepared: ${rebased} external links rebased.`)
