import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/**
 * The ingest manifest — `.sitebot/manifest.json`, docs/06 §3.6.
 *
 * One record per document plus the embedding model fingerprint. It is what
 * makes ingest idempotent: unchanged hashes mean zero embedding calls, and a
 * model or dimensions change is caught here with a clear message rather than
 * silently mixing embedding spaces, which is nearly impossible to debug from
 * the query side.
 */

export interface ManifestDocument {
  url: string
  contentHash: string
  lang?: string
  /** Stable per-chunk hashes the diff reuses. */
  chunkHashes: string[]
  etag?: string
  lastModified?: string
}

export interface ManifestSource {
  /** Declared source override, separate from each detected document language. */
  lang?: string
  id: string
  type: string
  label: string
  documents: Record<string, ManifestDocument>
}

export interface Manifest {
  version: 1
  model: string
  documentPrefix?: string
  dimensions?: number
  builtAt: string
  sources: Record<string, ManifestSource>
}

export const MANIFEST_VERSION = 1

export interface ModelFingerprint {
  model: string
  documentPrefix?: string
  dimensions?: number
}

export class ModelMismatchError extends Error {
  constructor(expected: ModelFingerprint, actual: ModelFingerprint) {
    super(
      `The knowledge index was built with "${expected.model}${expected.dimensions === undefined ? '' : ` (${expected.dimensions}d)`}" ` +
        `but the config now asks for "${actual.model}${actual.dimensions === undefined ? '' : ` (${actual.dimensions}d)`}".\n` +
        `Embedding spaces and document prefixes do not mix; run \`sitebot ingest --force\` to rebuild the index from scratch.`,
    )
    this.name = 'ModelMismatchError'
  }
}

export interface ManifestStoreOptions {
  /** Directory `.sitebot/manifest.json` lives in. Defaults to `<cwd>/.sitebot`. */
  dir?: string
}

export function manifestPath(options: ManifestStoreOptions = {}): string {
  return resolve(options.dir ?? process.cwd(), '.sitebot', 'manifest.json')
}

export async function readManifest(options: ManifestStoreOptions = {}): Promise<Manifest | null> {
  try {
    const raw = JSON.parse(await readFile(manifestPath(options), 'utf8')) as Manifest
    if (raw.version !== MANIFEST_VERSION) return null
    return raw
  } catch {
    return null
  }
}

/** Atomic write: a crash leaves the previous manifest, not a torn file. */
export async function writeManifest(
  manifest: Manifest,
  options: ManifestStoreOptions = {},
): Promise<void> {
  const file = manifestPath(options)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(manifest, null, 2))
  await rename(tmp, file)
}

/** Refuse incremental work across an embedding-model change (docs/06 §3.5). */
export function assertModelCompatible(manifest: Manifest | null, next: ModelFingerprint): void {
  if (manifest === null) return
  const mismatch =
    manifest.model !== next.model ||
    (manifest.documentPrefix ?? '') !== (next.documentPrefix ?? '') ||
    (manifest.dimensions ?? undefined) !== (next.dimensions ?? undefined)
  if (mismatch) throw new ModelMismatchError(manifest, next)
}
