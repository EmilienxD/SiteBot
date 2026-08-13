import type { Knowledge } from '@sitebot/config'
import { EngineError } from '../stream/errors.js'
import { MemoryVectorStore } from '../knowledge/memory-store.js'
import type { Chunk, VectorStore } from '../knowledge/store.js'
import { createPgVectorStore } from './vector-pgvector.js'
import { createSqliteVectorStore } from './vector-sqlite.js'
import { createUpstashVectorStore } from './vector-upstash.js'

/**
 * `knowledge.store` → a `VectorStore` — the Node-side counterpart of
 * `createSessionStore` (docs/06 §3.7, docs/01 §6).
 *
 * All five backends resolve here, including `memory` with an optional JSON
 * persistence file. The edge entry never reaches this module; an edge host
 * either defaults to in-RAM `memory` via the engine dep or hands a store in.
 */
export async function createNodeVectorStore(
  store: Knowledge['store'],
  options: { model?: string; baseDir?: string | null } = {},
): Promise<VectorStore> {
  switch (store.type) {
    case 'memory': {
      if (store.path === undefined) {
        return new MemoryVectorStore({
          ...(options.model === undefined ? {} : { model: options.model }),
        })
      }
      const { readFile, writeFile, rename, mkdir } = await import('node:fs/promises')
      const { dirname, resolve } = await import('node:path')
      const file = resolve(options.baseDir ?? process.cwd(), store.path)
      let initial: { model?: string; chunks?: Chunk[] } = {}
      try {
        initial = JSON.parse(await readFile(file, 'utf8')) as typeof initial
      } catch {
        // A missing file is a fresh index, not an error.
      }
      const memory = new MemoryVectorStore({
        model: options.model ?? initial.model ?? '',
        chunks: initial.chunks ?? [],
        persist: async (snapshot) => {
          await mkdir(dirname(file), { recursive: true })
          const tmp = `${file}.tmp`
          await writeFile(tmp, JSON.stringify(snapshot))
          // Atomic replace: a crash mid-write leaves the previous file, not a
          // truncated JSON half a process managed to read.
          await rename(tmp, file)
        },
      })
      return memory
    }
    case 'sqlite':
      return createSqliteVectorStore({
        path: store.path,
        ...(options.model === undefined ? {} : { model: options.model }),
      })
    case 'pgvector':
      return createPgVectorStore({
        url: store.url,
        table: store.table,
        ...(options.model === undefined ? {} : { model: options.model }),
      })
    case 'upstash':
      return createUpstashVectorStore({
        url: store.url,
        token: store.token,
        ...(options.model === undefined ? {} : { model: options.model }),
      })
    case 'custom': {
      const resolved = new URL(store.module, `file://${options.baseDir ?? process.cwd()}/`).href
      const module = (await import(/* @vite-ignore */ resolved)) as Record<string, unknown>
      for (const exportName of ['createVectorStore', 'default']) {
        const candidate = module[exportName]
        if (typeof candidate !== 'function') continue
        const built = (await (candidate as (o: unknown) => Promise<VectorStore>)(store)) as
          VectorStore | undefined
        if (built !== undefined) return built
      }
      throw new EngineError('not_ready', {
        message: `knowledge.store custom module "${store.module}" must export createVectorStore(store).`,
      })
    }
  }
}
