// Synthetic OpenAI HTTP/embedding fixture. This verifies packaging and protocol,
// never generation quality. No request is forwarded to a real provider.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

export async function providerFixture() {
  const keys = {
    chat: `sk-synthetic-chat-${randomUUID()}`,
    embedding: `sk-synthetic-embedding-${randomUUID()}`,
  }
  const calls = []
  const errors = []
  const streams = []
  let cancelled = 0
  let failure = false
  let embeddingFailure = false
  const server = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const part of request) raw += part
      const body = JSON.parse(raw)
      assert(calls.length < 160, 'Synthetic provider request ceiling exceeded')
      const embedding = request.url === '/v1/embeddings'
      assert(
        request.headers.authorization === `Bearer ${embedding ? keys.embedding : keys.chat}`,
        'Synthetic credential not received server-side',
      )
      calls.push({ kind: embedding ? 'embedding' : 'chat', body })
      if (embedding && embeddingFailure) {
        response.writeHead(503, { 'content-type': 'application/json' })
        return response.end(
          JSON.stringify({
            error: {
              message: `Synthetic embedding failure ${keys.embedding}`,
              type: 'server_error',
              code: 'server_error',
            },
          }),
        )
      }
      if (embedding) {
        const inputs = Array.isArray(body.input) ? body.input : [body.input]
        response.setHeader('content-type', 'application/json')
        return response.end(
          JSON.stringify({
            object: 'list',
            data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: [1, 0, 0] })),
            model: body.model,
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
        )
      }
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
        (body.tools ?? []).every((tool) => tool.name === 'search_knowledge_base'),
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
          name: 'search_knowledge_base',
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
        const retained = /\[(\d+)\] \{[^\n]+?"chunkId"/.exec(all.replaceAll('\\"', '"'))
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
    set embeddingFailure(value) {
      embeddingFailure = value
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
    tools: [],
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
        'Answer public documentation questions from indexed evidence. Search before factual answers. Cite supplied [n] numbers. Say when evidence is unavailable.',
      includePageContext: false,
    },
    siteContext: { description: 'Public documentation fixture.' },
    storage: { type: 'sqlite', path: './runtime-state/sessions.db' },
    agent: { maxSteps: 4, stopWhen: { tokens: 5000, seconds: 15 }, onMaxSteps: 'summarize' },
    knowledge: {
      sources: [{ type: 'text', id: 'public', content: 'Indexed public fixture.' }],
      embedding: {
        provider: 'openai',
        model: 'synthetic-embedding',
        apiKey: '${env.SITEBOT_TEST_EMBED_KEY}',
        baseUrl,
      },
      store: { type: 'memory', path: './.sitebot/index.json' },
      retrieval: {
        mode: 'tool',
        topK: 1,
        minScore: 0.5,
        maxContextTokens: 300,
        includeCitations: true,
      },
    },
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

export function knowledgeSnapshot() {
  return {
    model: 'synthetic-embedding',
    lastIndexed: '2026-01-01T00:00:00.000Z',
    chunks: ['en', 'fr'].map((lang) => ({
      id: `plans-${lang}`,
      text:
        lang === 'en'
          ? 'Pro includes 12 workspaces. The trial lasts 7 days.'
          : 'Le forfait Pro comprend 12 espaces. La période d’essai dure 7 jours.',
      embedding: [1, 0, 0],
      metadata: {
        url: `https://docs.example.com/${lang}/plans`,
        title: lang === 'en' ? 'Plans' : 'Forfaits',
        lang,
        language: lang,
        headingPath: [],
        sourceId: 'public',
        sourceType: 'text',
        contentHash: lang,
        updatedAt: '2026-01-01',
        tokens: 20,
      },
    })),
  }
}
