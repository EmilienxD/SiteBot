#!/usr/bin/env node
// Smoke test for a running example: health → /config → one chat turn, and
// optionally a server-tool round trip and a cross-origin preflight. Runs
// against the scripted offline model (e2e/fixtures/scripted-model.mjs), so no
// provider is called.
//
//   node test/smoke/smoke.mjs --endpoint http://localhost:3000/api/chat \
//     [--origin http://localhost:8000] [--key pk_...] \
//     [--tool 'find_service_slots {"date":"2026-09-28"}' --expect '"slots"']

import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    origin: { type: 'string' },
    key: { type: 'string' },
    asset: { type: 'string' },
    tool: { type: 'string' },
    expect: { type: 'string' },
    timeout: { type: 'string', default: '90' },
  },
})
if (!values.endpoint) fail('--endpoint is required')
const endpoint = values.endpoint.replace(/\/$/, '')
const headers = {
  ...(values.origin ? { origin: values.origin } : {}),
  ...(values.key ? { 'x-sitebot-key': values.key } : {}),
}

await step('health', async () => {
  const deadline = Date.now() + Number(values.timeout) * 1000
  for (;;) {
    try {
      const response = await fetch(`${endpoint}/health`)
      if (response.ok) return `${response.status}`
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`no healthy response within ${values.timeout}s`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
})

if (values.origin)
  await step('CORS preflight', async () => {
    const response = await fetch(endpoint, {
      method: 'OPTIONS',
      headers: {
        origin: values.origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    const allowed = response.headers.get('access-control-allow-origin')
    if (allowed !== values.origin)
      throw new Error(`status ${response.status}, access-control-allow-origin: ${allowed}`)
    return `${response.status}, allows ${allowed}`
  })

if (values.asset)
  await step('widget bundle', async () => {
    // A cross-origin module script is fetched in CORS mode: without the
    // header the browser downloads the bundle and refuses to run it.
    const response = await fetch(values.asset, { headers })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const allowed = response.headers.get('access-control-allow-origin')
    if (values.origin && allowed !== values.origin)
      throw new Error(`access-control-allow-origin: ${allowed}`)
    return `${response.status}, ${response.headers.get('content-type')}`
  })

await step('GET /config', async () => {
  const query = values.key ? `?key=${encodeURIComponent(values.key)}` : ''
  const response = await fetch(`${endpoint}/config${query}`, { headers })
  if (!response.ok) throw new Error(`status ${response.status}: ${await response.text()}`)
  const config = await response.json()
  if (typeof config.ui !== 'object') throw new Error('response has no `ui`')
  return `${response.status}, name "${config.name}"`
})

await step('chat', async () => {
  const text = await chat('hi there')
  if (!text.includes('scripted model')) throw new Error(`unexpected stream:\n${text.slice(0, 600)}`)
  return 'streamed an answer'
})

if (values.tool)
  await step(`tool ${values.tool.split(' ')[0]}`, async () => {
    const text = await chat(`call ${values.tool}`)
    const needle = values.expect ?? 'returned'
    if (!text.includes(needle))
      throw new Error(`expected ${needle} in the stream:\n${text.slice(0, 1200)}`)
    return `result contains ${needle}`
  })

process.stdout.write('\nsmoke: all checks passed\n')

async function chat(text) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: `s_${randomUlid()}`,
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }],
    }),
  })
  if (!response.ok) throw new Error(`status ${response.status}: ${await response.text()}`)
  return response.text()
}

function randomUlid() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  // The first character carries the timestamp's top bits and must be 0–7.
  const pick = (size) => alphabet[Math.floor(Math.random() * size)]
  return pick(8) + Array.from({ length: 25 }, () => pick(32)).join('')
}

async function step(name, run) {
  try {
    process.stdout.write(`✓ ${name} — ${await run()}\n`)
  } catch (error) {
    fail(`${name}: ${error instanceof Error ? error.message : error}`)
  }
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}
