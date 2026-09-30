import type { ProviderId } from '@sitebot/config'
import type { SystemModelMessage } from 'ai'
import type { ComposedPrompt } from './compose.js'

/** Select metadata per attempt, including fallback/degraded providers. */
export function cachedSystem(
  provider: ProviderId,
  system: string,
  composed?: ComposedPrompt,
): string | SystemModelMessage[] {
  // An opaque prompt hook can reorder/replace text. Its boundaries are unknown.
  if (
    composed === undefined ||
    composed.text !== system ||
    !['anthropic', 'bedrock'].includes(provider)
  )
    return system
  return composed.segments.map(({ text, cacheable }) => {
    const message: SystemModelMessage = { role: 'system', content: text }
    if (cacheable) {
      if (provider === 'bedrock')
        message.providerOptions = { bedrock: { cachePoint: { type: 'default' } } }
      else message.providerOptions = { anthropic: { cacheControl: { type: 'ephemeral' } } }
    }
    return message
  })
}
