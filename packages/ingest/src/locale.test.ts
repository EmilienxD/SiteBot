import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateConfig, type ResolvedConfig } from '@sitebot/config'
import { MemoryVectorStore } from '@sitebot/core'
import { extract } from './extract.js'
import { runIngest } from './pipeline.js'
import { readManifest } from './manifest.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sitebot-locale-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
function config(): ResolvedConfig {
  const result = validateConfig(
    {
      version: 1,
      name: 'Example',
      backend: { provider: 'openai', model: 'fixture' },
      prompt: { system: 'Website assistant' },
      knowledge: {
        sources: [{ type: 'files', glob: '*.html', baseUrl: 'https://example.com/docs' }],
        embedding: { provider: 'ollama', model: 'offline' },
        chunk: { strategy: 'fixed', minTokens: 0 },
        extract: { minChars: 0 },
      },
    },
    { env: {} },
  )
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}
const embedder = {
  embedBatch: async (texts: string[]) => ({
    embeddings: texts.map(() => [1, 0]),
    tokens: texts.length,
  }),
}

describe('source language metadata', () => {
  it('detects and normalizes HTML lang, leaving unknown or invalid language absent', () => {
    expect(extract('<html lang="FR-ca"><main>Bonjour</main></html>', { minChars: 0 }).lang).toBe(
      'fr-CA',
    )
    expect(
      extract('<html lang="invalid language"><main>Hello</main></html>', { minChars: 0 }).lang,
    ).toBeUndefined()
    expect(extract('<main>Hello</main>', { minChars: 0 }).lang).toBeUndefined()
  })
  it('persists original document language and real citation URLs and updates a metadata-only language change', async () => {
    const path = join(dir, 'guide.html')
    await writeFile(path, '<html lang="fr-CA"><main>Guide de démarrage.</main></html>')
    const store = new MemoryVectorStore()
    const options = { store, embedder, baseDir: dir, manifestDir: dir }
    await runIngest(config(), options)
    const url = 'https://example.com/docs/guide.html'
    expect((await store.documentChunks(url))[0]?.metadata).toMatchObject({
      lang: 'fr-CA',
      language: 'fr',
      url,
    })
    await writeFile(path, '<html lang="en"><main>Guide de démarrage.</main></html>')
    await runIngest(config(), options)
    expect((await store.documentChunks(url)).map((chunk) => chunk.metadata.lang)).toEqual(['en'])
    const manifest = await readManifest({ dir })
    expect(manifest?.sources.files?.documents[url]?.lang).toBe('en')
  })
  it('supports explicit source language for files and text with no page language', async () => {
    await writeFile(join(dir, 'guide.html'), '<html lang="en"><main>Documentation</main></html>')
    const deployment = config()
    deployment.knowledge.sources[0]!.lang = 'fr'
    deployment.knowledge.sources.push({
      type: 'text',
      id: 'german',
      lang: 'de',
      content: 'Dokumentation',
    })
    const store = new MemoryVectorStore()
    await runIngest(deployment, { store, embedder, baseDir: dir, manifestDir: dir })
    expect(
      (await store.documentChunks('https://example.com/docs/guide.html'))[0]?.metadata.lang,
    ).toBe('fr')
    expect((await store.documentChunks('sitebot:german'))[0]?.metadata.lang).toBe('de')
  })
  it('retains detected language on a 304 and refetches when the source-language override changes', async () => {
    const deployment = config()
    deployment.knowledge.sources = [
      {
        type: 'sitemap',
        id: 'web',
        url: 'https://example.com/sitemap.xml',
        include: [],
        exclude: [],
      },
    ]
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /')
      if (url.endsWith('sitemap.xml'))
        return new Response('<urlset><url><loc>https://example.com/guide</loc></url></urlset>')
      const conditional = new Headers(init?.headers).get('if-none-match')
      return conditional
        ? new Response(null, { status: 304 })
        : new Response('<html lang="fr"><main>Guide</main></html>', {
            headers: { etag: 'guide-v1' },
          })
    }) as typeof fetch
    const store = new MemoryVectorStore()
    const options = { store, embedder, fetchImpl, manifestDir: dir }
    await runIngest(deployment, options)
    await runIngest(deployment, options)
    expect((await store.documentChunks('https://example.com/guide'))[0]?.metadata.lang).toBe('fr')
    deployment.knowledge.sources[0]!.lang = 'de'
    await runIngest(deployment, options)
    expect((await store.documentChunks('https://example.com/guide'))[0]?.metadata.lang).toBe('de')
    deployment.knowledge.sources[0]!.lang = undefined
    await runIngest(deployment, options)
    expect((await store.documentChunks('https://example.com/guide'))[0]?.metadata.lang).toBe('fr')
  })
})
