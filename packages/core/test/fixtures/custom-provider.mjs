// A `provider: custom` module — used by providers.test.ts. The factory gets the
// backend entry, so it can read apiKey/baseUrl/headers like a built-in adapter.
import { MockLanguageModelV3 } from 'ai/test'

export function createModel(entry) {
  return new MockLanguageModelV3({ modelId: `custom:${entry.model}` })
}

export function notAModel() {
  return { hello: 'world' }
}

export const notAFunction = 42
