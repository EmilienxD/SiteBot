import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSafeFetch } from './safe-fetch.js'

/**
 * A real round trip through the pinned-DNS dispatcher. Node's happy-eyeballs
 * connect asks `lookup` for *all* addresses; a lookup that answered with one
 * string failed every request with "Invalid IP address: undefined", and every
 * HTTP tool with it.
 */
describe('createSafeFetch', () => {
  let server: Server
  let port: number

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('fetches by hostname through the pinned lookup', async () => {
    const { fetch } = createSafeFetch()
    const response = await fetch(`http://localhost:${port}/`)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('resolves and caches the addresses it pins', async () => {
    const { resolveHost } = createSafeFetch()
    const first = await resolveHost('localhost')
    expect(first.length).toBeGreaterThan(0)
    expect(await resolveHost('localhost')).toBe(first)
  })
})
