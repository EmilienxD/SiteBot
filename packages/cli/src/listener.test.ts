import { describe, expect, it } from 'vitest'
import { validateConfig } from '@sitebot/config'
import { startListener } from './commands/listener.js'

function makeConfig() {
  const result = validateConfig(
    {
      version: 1,
      name: 'Acme',
      backend: { provider: 'openai', model: 'gpt-4o-mini', apiKey: '${env.OPENAI_API_KEY}' },
      prompt: { system: 'You are a helpful assistant for Acme.' },
    },
    { env: { OPENAI_API_KEY: 'sk-test-key-value-long-enough-123' } },
  )
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

describe('sitebot dev --inspect stream tap', () => {
  it('reports frames written as plain Uint8Arrays, even split mid-character', async () => {
    // The chat route pipes a web stream into the response, so its chunks are
    // `Uint8Array`s rather than Buffers. A tap that read only strings and
    // Buffers logged nothing at all.
    const frames: Array<{ type: string; raw: string }> = []
    const bytes = new TextEncoder().encode(
      'data: {"type":"start"}\n\ndata: {"type":"text-delta","delta":"café"}\n\ndata: [DONE]\n\n',
    )
    // Split inside the two-byte "é" to prove the decoder streams.
    const split = bytes.indexOf(0xc3) + 1
    const running = await startListener({
      config: makeConfig(),
      basePath: '/api/chat',
      host: '127.0.0.1',
      port: 0,
      onStreamFrame: (frame) => frames.push(frame),
      extraRoutes: (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(new Uint8Array(bytes.subarray(0, split)))
        response.write(new Uint8Array(bytes.subarray(split)))
        response.end()
        return true
      },
    })
    try {
      await (await fetch(`${running.url}/api/chat`)).text()
    } finally {
      await running.close()
    }
    expect(frames.map((frame) => frame.type)).toEqual(['start', 'text-delta', 'done'])
    expect(frames[1]?.raw).toContain('café')
  })
})
