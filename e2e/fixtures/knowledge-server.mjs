// Real ingest, retrieval, provider adapters and widget; only remote APIs are fixtures.
import { createServer } from 'node:http'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateConfig } from '../../packages/config/dist/index.js'
import { MemoryVectorStore } from '../../packages/core/dist/index.js'
import { createNodeHandler } from '../../packages/server/dist/node.js'
import { runIngest, createQueryEmbedder } from '../../packages/ingest/dist/index.js'

const PORT = 4319
const origin = `http://127.0.0.1:${PORT}`
const evidence = { embeddings: [], reranks: [], messages: [] }
let chat
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/chat')) return await chat(req, res)
    if (req.method === 'POST') {
      let data = ''
      for await (const part of req) data += part
      const body = JSON.parse(data)
      if (req.url === '/v1/embeddings') {
        const texts = Array.isArray(body.input) ? body.input : [body.input]
        evidence.embeddings.push(texts)
        return json(res, {
          object: 'list',
          model: body.model,
          data: texts.map((text, index) => ({
            object: 'embedding',
            index,
            embedding: /refunds|returns/i.test(text) ? [0, 1] : [1, 0],
          })),
          usage: {
            prompt_tokens: texts.reduce((n, text) => n + Math.ceil(text.length / 4), 0),
            total_tokens: 100,
          },
        })
      }
      if (req.url === '/v2/rerank') {
        evidence.reranks.push(body)
        return json(res, {
          results: body.documents.map((text, index) => ({
            index,
            relevance_score: /refunds|returns/i.test(text) ? 0.95 : 0.1,
          })),
        })
      }
      if (req.url === '/v1/messages') {
        evidence.messages.push(body)
        const prompt = body.system.map((part) => part.text).join('\n\n')
        const answer = prompt.includes('30 days')
          ? 'Returns are accepted within 30 days for a full refund [1].'
          : 'No matching policy was found.'
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type, payload) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
        send('message_start', {
          message: {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        })
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } })
        send('content_block_stop', { index: 0 })
        send('message_delta', {
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 20 },
        })
        send('message_stop', {})
        return res.end()
      }
    }
    if (req.url === '/evidence') return json(res, evidence)
    if (req.url === '/docs/policies.md') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(
        `<!doctype html><html lang="en"><head><title>Policies</title></head><body><main><h1>Policies</h1>${text
          .split('\n\n')
          .map((paragraph) => `<p>${paragraph}</p>`)
          .join('')}</main></body></html>`,
      )
    }
    if (req.url.startsWith('/widget/')) {
      const name = req.url.slice('/widget/'.length)
      if (!['sitebot.js', 'sitebot-panel.js', 'sitebot-shared.js'].includes(name)) {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/javascript' })
      return res.end(await readFile(new URL(`../../packages/widget/dist/${name}`, import.meta.url)))
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html lang="en"><head><title>Knowledge feature verification</title></head><body>
      <main><h1>Knowledge feature verification</h1><p>Ask about the returns policy to test semantic splitting, reranking and prompt cache boundaries.</p></main>
      <script>const attach = Element.prototype.attachShadow; Element.prototype.attachShadow = function(init) {return attach.call(this, {...init, mode:'open'})}</script>
      <script type="module" src="/widget/sitebot.js" data-endpoint="/api/chat"></script></body></html>`)
  } catch (error) {
    res.writeHead(500)
    res.end(String(error))
  }
})
function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
const dir = await mkdtemp(join(tmpdir(), 'sitebot-feature-e2e-'))
const text = [
  'Shipping orders leave our warehouse within two days. '.repeat(2),
  'Delivery is tracked for every parcel and region. '.repeat(2),
  'Returns are accepted within 30 days for a full refund. '.repeat(2),
  'Refunds are sent back to your original payment method. '.repeat(2),
].join('\n\n')
await writeFile(join(dir, 'policies.md'), `# Policies\n\n${text}`)
const parsed = validateConfig({
  version: 1,
  name: 'Knowledge verification',
  mode: 'chat',
  backend: {
    provider: 'anthropic',
    model: 'claude-fixture',
    apiKey: 'fixture',
    baseUrl: `${origin}/v1`,
    maxRetries: 0,
  },
  prompt: {
    system: 'Answer using the retrieved policy and cite [1].',
    guardrails: { refuseOffTopic: true },
  },
  siteContext: { company: 'Acme' },
  knowledge: {
    sources: [{ type: 'files', id: 'policies', glob: 'policies.md', baseUrl: `${origin}/docs` }],
    extract: { minChars: 0 },
    chunk: { strategy: 'semantic', maxTokens: 80, minTokens: 10, overlapTokens: 0 },
    embedding: {
      provider: 'openai-compatible',
      model: 'fixture-embed',
      baseUrl: `${origin}/v1`,
      apiKey: 'fixture',
      dimensions: 2,
    },
    retrieval: {
      mode: 'always',
      topK: 1,
      minScore: 0.8,
      dedupeByUrl: false,
      rerank: { provider: 'cohere', apiKey: 'fixture', baseUrl: origin },
    },
  },
  storage: { type: 'none' },
  security: { allowedOrigins: [origin], rateLimit: { perSession: '1000/5m', perIp: '10000/1h' } },
  telemetry: { logLevel: 'error' },
})
if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
const config = parsed.value
const store = new MemoryVectorStore({ model: 'fixture-embed' })
evidence.ingest = await runIngest(config, { store, baseDir: dir, manifestDir: dir })
evidence.chunks = (await store.documentChunks(`${origin}/docs/policies.md`)).map((chunk) => ({
  text: chunk.text,
  tokens: chunk.metadata.tokens,
  headingPath: chunk.metadata.headingPath,
}))
const calls = evidence.embeddings.length
evidence.unchanged = await runIngest(config, { store, baseDir: dir, manifestDir: dir })
evidence.unchangedEmbeddingCalls = evidence.embeddings.length - calls
chat = createNodeHandler(config, {
  deps: { knowledge: { store, embedder: await createQueryEmbedder(config.knowledge.embedding) } },
})
console.warn(`Knowledge verification ready at ${origin}; ${evidence.chunks.length} semantic chunks`)
