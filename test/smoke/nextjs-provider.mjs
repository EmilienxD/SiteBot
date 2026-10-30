// Synthetic OpenAI HTTP fixture. This verifies packaging and protocol,
// never generation quality. No request is forwarded to a real provider.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

export async function providerFixture() {
  const keys = {
    chat: `sk-synthetic-chat-${randomUUID()}`,
  }
  const calls = []
  const errors = []
  const streams = []
  let cancelled = 0
  let failure = false
  const server = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const part of request) raw += part
      const body = JSON.parse(raw)
      assert(calls.length < 160, 'Synthetic provider request ceiling exceeded')
      assert.equal(request.headers.authorization, `Bearer ${keys.chat}`)
      calls.push({ kind: 'chat', body })
      assert.equal(request.url, '/v1/responses')
      if (failure) {
        response.writeHead(503, { 'content-type': 'application/json' })
        return response.end(
          JSON.stringify({
            error: {
              message: `Synthetic failure ${keys.chat}`,
              type: 'server_error',
              code: 'server_error',
            },
          }),
        )
      }
      const all = JSON.stringify(body)
      const locale = /Respond in language ([\w-]+)/.exec(all)?.[1] ?? 'en'
      const userIndex = body.input.findLastIndex((item) => item.role === 'user')
      const user = body.input[userIndex]
      const question = JSON.stringify(user?.content ?? '')
      const result = body.input
        .slice(userIndex + 1)
        .findLast((item) => item.type === 'function_call_output')
      const slow = question.includes('slow')
      assert(body.max_output_tokens <= 180, 'Output ceiling missing')
      assert(
        (body.tools ?? []).every((tool) => ['lookup_plan'].includes(tool.name)),
        'Unexpected action capability',
      )
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      response.socket?.setNoDelay(true)
      const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`)
      send({
        type: 'response.created',
        response: {
          id: `resp_${randomUUID()}`,
          created_at: Math.floor(Date.now() / 1000),
          model: body.model,
        },
      })
      const complete = () => {
        send({
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 30,
              output_tokens: 10,
              total_tokens: 40,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        })
        response.end()
      }
      if (
        !slow &&
        (!result || question.includes('loop')) &&
        !question.includes('followup') &&
        (body.tools ?? []).length
      ) {
        const item = {
          type: 'function_call',
          id: `fc_${randomUUID()}`,
          call_id: `call_${randomUUID()}`,
          name: 'lookup_plan',
          arguments: JSON.stringify({
            query: locale === 'fr' ? 'forfait Pro essai' : 'Pro plan trial',
          }),
        }
        send({ type: 'response.output_item.added', output_index: 0, item })
        send({
          type: 'response.output_item.done',
          output_index: 0,
          item: { ...item, status: 'completed' },
        })
        return complete()
      }
      let text
      if (question.includes('followup')) {
        const retained = /\[(\d+)\] \{[^\n]*?"chunkId"/.exec(all.replaceAll('\\"', '"'))
        assert(retained, 'Stored source mapping did not reach the model after restart')
        text =
          locale === 'fr'
            ? `La période d’essai dure 7 jours [${retained[1]}].`
            : `The trial lasts 7 days [${retained[1]}].`
      } else if (result) {
        const output = JSON.parse(result.output)
        const first = output.results?.[0]
        text = first
          ? `${locale === 'fr' ? 'Selon la documentation' : 'According to the docs'}: ${locale === 'fr' ? 'Le forfait Pro comprend 12 espaces. Essai : 7 jours.' : 'Pro includes 12 workspaces. Trial: 7 days.'} [${first.n}].`
          : 'The documentation is unavailable.'
      } else text = 'Synthetic runtime stream. '
      const item = { type: 'message', id: `msg_${randomUUID()}` }
      send({ type: 'response.output_item.added', output_index: 0, item })
      const chunks = slow
        ? Array.from({ length: 100 }, () => text)
        : [text.slice(0, 24), text.slice(24)]
      let index = 0
      const stream = { slow, startedAt: Date.now(), deltas: 0, closedAt: null, completed: false }
      streams.push(stream)
      const timer = setInterval(
        () => {
          if (index < chunks.length) {
            stream.deltas++
            send({ type: 'response.output_text.delta', item_id: item.id, delta: chunks[index++] })
          } else {
            stream.completed = true
            clearInterval(timer)
            send({ type: 'response.output_item.done', output_index: 0, item })
            complete()
          }
        },
        slow ? 150 : 120,
      )
      response.on('close', () => {
        stream.closedAt = Date.now()
        clearInterval(timer)
        if (slow && index < chunks.length) cancelled++
      })
    } catch (error) {
      errors.push(error.message)
      if (response.headersSent) response.destroy(error)
      else {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: error.message } }))
      }
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    keys,
    calls,
    errors,
    streams,
    get cancelled() {
      return cancelled
    },
    set failure(value) {
      failure = value
    },
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  }
}

export function qaConfig(baseUrl) {
  return {
    version: 1,
    name: 'Public Docs (synthetic runtime fixture)',
    mode: 'chat',
    tools: [
      {
        name: 'lookup_plan',
        description: 'Read the application plan details.',
        readOnly: true,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { results: { type: 'array', items: { type: 'object' } } },
          required: ['results'],
          additionalProperties: false,
        },
        executor: { type: 'module', path: './application-tool.mjs' },
      },
    ],
    backend: {
      provider: 'openai',
      model: 'synthetic-runtime',
      apiKey: '${env.SITEBOT_TEST_CHAT_KEY}',
      baseUrl,
      maxOutputTokens: 180,
      maxRetries: 0,
    },
    prompt: {
      system:
        'Answer public documentation questions from application records. Search before factual answers. Cite supplied [n] numbers. Say when evidence is unavailable.',
      includePageContext: false,
    },
    siteContext: { description: 'Public documentation fixture.' },
    storage: { type: 'sqlite', path: './runtime-state/sessions.db' },
    agent: { maxSteps: 4, stopWhen: { tokens: 5000, seconds: 15 }, onMaxSteps: 'summarize' },
    security: {
      rateLimit: { perSession: '12/1m', perIp: '100/1m' },
      budget: { maxTokensPerSession: 10000, onExceeded: 'error' },
    },
    telemetry: { logLevel: 'silent' },
    ui: {
      locale: 'auto',
      supportedLocales: ['en', 'fr'],
      translations: { fr: { messages: { placeholder: 'Votre question…' } } },
      strings: { fr: { send: 'Envoyer' } },
    },
  }
}

// Consumer-owned fixture, copied beside the relocated server configuration.
export const applicationTool = `export default function (_input, ctx) {
  const lang = ctx.locale === 'fr' ? 'fr' : 'en'
  const text = lang === 'fr' ? 'Le forfait Pro comprend 12 espaces. Essai : 7 jours.' : 'Pro includes 12 workspaces. Trial: 7 days.'
  const source = ctx.sources.register({ id: 'plans-' + lang, title: 'Plans', url: 'https://docs.example.com/' + lang + '/plans', text, lang })
  return { results: [{ ...source, text }] }
}`
