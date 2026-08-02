import { validateConfig, type ResolvedConfig } from '@sitebot/config'
import type { UIMessage } from 'ai'
import type { DeepPartial, SiteBotConfigInput } from '@sitebot/config'
import { createBudgetTracker } from '../src/guards/budget.js'
import { silentLogger } from '../src/telemetry/logger.js'
import type { RequestContext } from '../src/types.js'

/** The smallest config that validates, as the engine tests need it. */
export function testConfig(overrides: DeepPartial<SiteBotConfigInput> = {}): ResolvedConfig {
  const result = validateConfig(
    {
      version: 1,
      name: 'Acme',
      backend: { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'test-key' },
      prompt: { system: 'You are Acme’s website assistant.' },
      ...overrides,
    },
    { env: {} },
  )
  if (!result.ok) {
    throw new Error(`test config did not validate: ${JSON.stringify(result.errors, null, 2)}`)
  }
  return result.value
}

export function testContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: 'req_test',
    sessionId: 's_01J9X8Y7Z6ABCDEFGHJKMNPQRS',
    identity: null,
    pageContext: null,
    origin: 'https://acme.com',
    locale: 'en-US',
    ip: '203.0.113.5',
    signal: new AbortController().signal,
    logger: silentLogger,
    budget: createBudgetTracker(),
    ...overrides,
  }
}

export function userMessage(text: string, id = 'm_1'): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

/** Read an SSE body to completion and return the decoded `data:` payloads. */
export async function readSse(response: Response): Promise<string[]> {
  const text = await response.text()
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
}

/** The concatenated assistant text of an SSE body. */
export async function streamedText(response: Response): Promise<string> {
  const events = await readSse(response)
  let out = ''
  for (const event of events) {
    if (event === '[DONE]') continue
    const parsed = JSON.parse(event) as { type: string; delta?: string }
    if (parsed.type === 'text-delta' && typeof parsed.delta === 'string') out += parsed.delta
  }
  return out
}
