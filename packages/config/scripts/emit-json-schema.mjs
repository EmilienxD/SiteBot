#!/usr/bin/env node
/**
 * Build step: write the published JSON Schema from the Zod source.
 *
 * Runs after tsup so it imports the same artifact consumers get — if the
 * bundled build cannot produce the schema, that is a build failure, not
 * something to discover after publishing (docs/02-configuration.md §14).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// pathToFileURL, not the bare path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unsupported URL scheme.
const { emitJsonSchema, JSON_SCHEMA_PATH } = await import(
  pathToFileURL(resolve(packageRoot, 'dist/index.js')).href
)

const target = resolve(packageRoot, JSON_SCHEMA_PATH)
await mkdir(dirname(target), { recursive: true })
await writeFile(target, `${JSON.stringify(emitJsonSchema(), null, 2)}\n`, 'utf8')

console.log(`emitted ${JSON_SCHEMA_PATH}`)
