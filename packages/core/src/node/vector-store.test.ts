import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNodeVectorStore } from './vector-store.js'
import type { Chunk } from '../knowledge/store.js'
import type { MemoryVectorStore } from '../knowledge/memory-store.js'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sitebot-snapshot-test-'))
})
afterEach(async () => {
  const target = resolve(directory)
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith('sitebot-snapshot-test-')
  )
    throw new Error('Unsafe test cleanup target')
  await rm(target, { recursive: true, force: true })
})
const chunk: Chunk = {
  id: 'public',
  text: 'Public documentation.',
  embedding: [1, 0],
  metadata: {
    url: 'https://example.com/docs',
    title: 'Docs',
    headingPath: [],
    sourceId: 'public',
    sourceType: 'text',
    contentHash: 'public',
    updatedAt: '2026-01-01',
    tokens: 5,
  },
}

describe('file-backed public knowledge snapshot', () => {
  it('preserves snapshot bytes and indexing time on query-only load/disposal, while persisting mutations', async () => {
    const path = join(directory, 'knowledge.json')
    const snapshot = JSON.stringify(
      { model: 'fixture', chunks: [chunk], lastIndexed: '2026-01-01T00:00:00.000Z' },
      null,
      2,
    )
    await writeFile(path, snapshot)
    const store = await createNodeVectorStore({ type: 'memory', path })
    expect((await store.stats()).lastIndexed).toBe('2026-01-01T00:00:00.000Z')
    expect((await store.query([1, 0], { topK: 1 }))[0]?.chunk.id).toBe('public')
    await store.close()
    expect(await readFile(path, 'utf8')).toBe(snapshot)
    await store.upsert([{ ...chunk, text: 'Updated public documentation.' }])
    await store.close()
    expect(JSON.parse(await readFile(path, 'utf8')).chunks[0].text).toBe(
      'Updated public documentation.',
    )
    ;(store as MemoryVectorStore).setModel('updated-model')
    await store.close()
    expect(JSON.parse(await readFile(path, 'utf8')).model).toBe('updated-model')
  })

  it('propagates corruption/read errors and can load a repaired file on the next attempt', async () => {
    const path = join(directory, 'knowledge.json')
    await writeFile(path, '{invalid')
    await expect(createNodeVectorStore({ type: 'memory', path })).rejects.toThrow(SyntaxError)
    await expect(createNodeVectorStore({ type: 'memory', path: directory })).rejects.toThrow()
    await writeFile(path, JSON.stringify({ chunks: [chunk] }))
    const store = await createNodeVectorStore({ type: 'memory', path })
    expect((await store.stats()).chunks).toBe(1)
    await store.close()
  })

  it('keeps missing indexes empty without writing on query-only disposal', async () => {
    const path = join(directory, 'missing.json')
    const store = await createNodeVectorStore({ type: 'memory', path })
    expect((await store.stats()).chunks).toBe(0)
    await store.close()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
