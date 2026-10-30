import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { validateConfig, type ResolvedConfig } from '@sitebot/config'
import { createFetchHandler } from './fetch.js'

/**
 * Real-provider smoke tests — `pnpm test:live` only (docs/04 §10).
 *
 * Everything else in the repo runs against scripted models. These send real
 * requests through the whole server — config, provider adapter, engine, agent
 * loop, SSE encoding — so a provider SDK, model id or tool-calling dialect that
 * the mocks cannot represent fails here. Each provider is gated on its own
 * variable and skips without it; nothing here runs in `pnpm test` or CI.
 *
 *   ANTHROPIC_API_KEY           SITEBOT_LIVE_ANTHROPIC_MODEL (default claude-haiku-4-5-20251001)
 *   OPENAI_API_KEY              SITEBOT_LIVE_OPENAI_MODEL    (default gpt-5-mini)
 *   SITEBOT_LIVE_OLLAMA_MODEL   a local model with tool calling, e.g. qwen2.5:14b
 *                               SITEBOT_LIVE_OLLAMA_URL (default http://localhost:11434/v1)
 *
 * Assertions are about the protocol, not the prose: a real model's wording is
 * not stable, but whether it streamed, called the tool and used its output is.
 */

const env = process.env

interface LiveProvider {
  name: string
  enabled: boolean
  backend: Record<string, unknown>
}

const PROVIDERS: LiveProvider[] = [
  {
    name: 'anthropic',
    enabled: env['ANTHROPIC_API_KEY'] !== undefined,
    backend: {
      provider: 'anthropic',
      model: env['SITEBOT_LIVE_ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5-20251001',
    },
  },
  {
    name: 'openai',
    enabled: env['OPENAI_API_KEY'] !== undefined,
    backend: { provider: 'openai', model: env['SITEBOT_LIVE_OPENAI_MODEL'] ?? 'gpt-5-mini' },
  },
  {
    name: 'ollama',
    enabled: env['SITEBOT_LIVE_OLLAMA_MODEL'] !== undefined,
    backend: {
      provider: 'ollama',
      model: env['SITEBOT_LIVE_OLLAMA_MODEL'] ?? 'unset',
      ...(env['SITEBOT_LIVE_OLLAMA_URL'] === undefined
        ? {}
        : { baseUrl: env['SITEBOT_LIVE_OLLAMA_URL'] }),
    },
  },
]

const ORIGIN = 'https://live.sitebot.test'
const TIMEOUT = 180_000

const sessionId = () => `s_${randomUUID()}`

interface StreamEvent {
  type: string
  [key: string]: unknown
}

interface Reply {
  status: number
  events: StreamEvent[]
  /** Milliseconds from the request to each network chunk that carried a text delta. */
  deltaArrivals: number[]
  text: string
}

function config(backend: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const result = validateConfig(
    {
      version: 1,
      name: 'Harbor & Pine',
      backend: { ...backend, temperature: 0, maxOutputTokens: 400, maxRetries: 1 },
      prompt: {
        system:
          'You are the assistant on the Harbor & Pine coffee roastery website. Answer in at most three sentences.',
      },
      security: { allowedOrigins: [ORIGIN], rateLimit: { perSession: '100/5m' } },
      ...extra,
    },
    { env: {} },
  )
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2))
  return result.value
}

/** One handler per test: it owns the session store a resume must find again. */
function client(cfg: ResolvedConfig) {
  const handler = createFetchHandler(cfg)
  return (body: Record<string, unknown>) => post(handler, body)
}

async function post(
  handler: ReturnType<typeof createFetchHandler>,
  body: Record<string, unknown>,
): Promise<Reply> {
  const started = Date.now()
  const response = await handler(
    new Request(`${ORIGIN}/api/chat`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  const events: StreamEvent[] = []
  const deltaArrivals: number[] = []
  let buffer = ''
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    let sawDelta = false
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      const event = JSON.parse(line.slice(6)) as StreamEvent
      events.push(event)
      if (event.type === 'text-delta') sawDelta = true
    }
    if (sawDelta) deltaArrivals.push(Date.now() - started)
  }
  const text = events
    .filter((event) => event.type === 'text-delta')
    .map((event) => String(event['delta']))
    .join('')
  return { status: response.status, events, deltaArrivals, text }
}

const userMessage = (text: string) => ({
  id: `m_${Math.random().toString(36).slice(2)}`,
  role: 'user',
  parts: [{ type: 'text', text }],
})

function errorsIn(reply: Reply): unknown[] {
  return reply.events.filter((event) => event.type === 'error' || event.type === 'data-error')
}

for (const provider of PROVIDERS) {
  describe.skipIf(!provider.enabled)(`live provider: ${provider.name}`, () => {
    it(
      'streams an answer incrementally over SSE',
      async () => {
        const reply = await client(config(provider.backend))({
          sessionId: sessionId(),
          messages: [
            userMessage(
              'In four or five sentences, explain why freshly roasted coffee tastes better.',
            ),
          ],
        })
        expect(reply.status).toBe(200)
        expect(errorsIn(reply)).toEqual([])
        expect(reply.text.length).toBeGreaterThan(40)
        // Streamed, not buffered: deltas arrive in more than one network chunk,
        // spread over time rather than all at the end.
        expect(reply.deltaArrivals.length).toBeGreaterThan(1)
        expect(reply.deltaArrivals.at(-1)! - reply.deltaArrivals[0]!).toBeGreaterThan(0)
        expect(reply.events.at(-1)?.type).toBe('finish')
      },
      TIMEOUT,
    )

    it(
      'calls a server tool and answers from its output',
      async () => {
        const calls: unknown[] = []
        // Agent mode: chat mode is one step by design (docs/04 §4), so the
        // model never gets a turn to use the tool's output there.
        const cfg = config(provider.backend, {
          mode: 'agent',
          prompt: {
            system:
              'You are the assistant on the Harbor & Pine coffee roastery website. ' +
              'You do not know stock levels; always call check_stock for stock questions. ' +
              'Answer in one sentence.',
          },
          tools: [
            {
              outputSchema: {},
              name: 'check_stock',
              description: 'Look up how many bags of a coffee are in stock.',
              readOnly: true,
              parameters: {
                type: 'object',
                properties: { coffee: { type: 'string', description: 'The coffee name.' } },
                required: ['coffee'],
              },
              execute: async (input: unknown) => {
                calls.push(input)
                return { coffee: 'Huila', bagsInStock: 37 }
              },
            },
          ],
        })
        const reply = await client(cfg)({
          sessionId: sessionId(),
          messages: [userMessage('How many bags of the Huila coffee do you have in stock?')],
        })
        expect(errorsIn(reply)).toEqual([])
        expect(calls).toHaveLength(1)
        expect(JSON.stringify(calls[0]).toLowerCase()).toContain('huila')
        const input = reply.events.find((event) => event.type === 'tool-input-available')
        expect(input?.['toolName']).toBe('check_stock')
        expect(reply.events.some((event) => event.type === 'tool-output-available')).toBe(true)
        // The number only exists in the tool output.
        expect(reply.text).toMatch(/37|thirty-seven/i)
      },
      TIMEOUT,
    )

    it(
      'suspends for approval, then runs the approved tool on resume',
      async () => {
        const tickets: unknown[] = []
        const cfg = config(provider.backend, {
          mode: 'agent',
          prompt: {
            system:
              'You are the support assistant on the Harbor & Pine website. When a visitor ' +
              'reports a problem, call create_ticket right away with a short summary; do ' +
              'not ask follow-up questions. After it succeeds, tell them the ticket id.',
          },
          agent: { maxSteps: 4 },
          tools: [
            {
              outputSchema: {},
              name: 'create_ticket',
              description: 'Open a support ticket for the visitor.',
              readOnly: false,
              requiresApproval: true,
              parameters: {
                type: 'object',
                properties: { summary: { type: 'string', description: 'One-line summary.' } },
                required: ['summary'],
              },
              execute: async (input: unknown) => {
                tickets.push(input)
                return { ticketId: 'HP-4417' }
              },
            },
          ],
        })
        const session = sessionId()
        const send = client(cfg)
        const first = await send({
          sessionId: session,
          messages: [userMessage('My grinder arrived broken. Please open a ticket for me.')],
        })
        expect(errorsIn(first)).toEqual([])
        const request = first.events.find((event) => event.type === 'data-approval-request')
          ?.data as { approvalId: string; runId: string; toolName: string } | undefined
        expect(request?.toolName).toBe('create_ticket')
        // Nothing runs before the visitor approves.
        expect(tickets).toHaveLength(0)

        const second = await send({
          sessionId: session,
          messages: [],
          trigger: 'resume',
          resume: {
            runId: request!.runId,
            approvals: [{ approvalId: request!.approvalId, decision: 'approve' }],
          },
        })
        expect(errorsIn(second)).toEqual([])
        expect(tickets).toHaveLength(1)
        expect(second.text).toContain('HP-4417')
      },
      TIMEOUT,
    )
  })
}
