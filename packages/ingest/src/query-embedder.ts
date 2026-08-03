import { embed } from 'ai'
import type { QueryEmbedder } from '@sitebot/core'
import { createEmbeddingModel, type EmbeddingConfigLike } from './embedding.js'

/**
 * The query-time embedder the engine wraps around an `EmbeddingModel`.
 *
 * One model per engine instance; `embed` is a single lookup so the adapter is
 * a thin pass-through. Tests bypass this and inject a fake `QueryEmbedder`.
 */
export function createQueryEmbedder(config: EmbeddingConfigLike): Promise<QueryEmbedder> {
  return createEmbeddingModel(config).then(({ model, modelId }) => ({
    modelId,
    async embed(text: string) {
      const result = await embed({ model, value: text, maxRetries: 2 })
      return {
        embedding: result.embedding,
        tokens: result.usage?.tokens ?? Math.ceil(text.length / 4),
      }
    },
  }))
}
