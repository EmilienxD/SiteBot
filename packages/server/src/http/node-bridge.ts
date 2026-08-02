import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

/**
 * Node `IncomingMessage`/`ServerResponse` ↔ Web `Request`/`Response`.
 *
 * This is the only genuinely non-trivial adapter code in the package, and all
 * three Node-based adapters (node, express, fastify) share it. Two things it
 * has to get right:
 *
 *  1. **Never buffer the request body.** The body is wrapped as a stream so the
 *     size cap in `readBodyWithLimit` can abort a hostile upload partway
 *     through rather than after it has already been held in memory.
 *  2. **Never buffer the response body.** An SSE response that is buffered is
 *     not an SSE response — the whole product is tokens arriving as they are
 *     produced. `flushHeaders()` and a chunk-by-chunk pump are load-bearing.
 */

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

export interface ToWebRequestOptions {
  /** Overrides the scheme when the proxy topology is known. */
  protocol?: string
}

export function toWebRequest(
  incoming: IncomingMessage,
  options: ToWebRequestOptions = {},
): Request {
  const method = incoming.method ?? 'GET'
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else {
      headers.set(name, value)
    }
  }

  const socket = incoming.socket as { encrypted?: boolean } | undefined
  const protocol =
    options.protocol ??
    headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ??
    (socket?.encrypted === true ? 'https' : 'http')
  const host = headers.get('host') ?? 'localhost'
  const url = new URL(incoming.url ?? '/', `${protocol}://${host}`)

  // A client that hangs up mid-stream must abort the model call (docs/03 §11).
  // Nothing wires the socket to `Request.signal` for us, so it is bridged here —
  // through `RequestInit`, not by wrapping the request afterwards. A `Proxy`
  // around a `Request` looks like it would work and does not: the accessors on
  // `Request.prototype` need the real receiver, so every framework that reads
  // `request.url` through the wrapper gets an illegal-invocation error instead.
  const controller = new AbortController()
  incoming.once('aborted', () => {
    controller.abort()
  })
  incoming.once('close', () => {
    if (!incoming.readableEnded) controller.abort()
  })

  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    signal: controller.signal,
  }
  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>
    // Required by undici whenever a streaming body is supplied.
    init.duplex = 'half'
  }

  return new Request(url, init)
}

export async function sendWebResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') {
      const existing = headers[name]
      headers[name] = Array.isArray(existing) ? [...existing, value] : [value]
      continue
    }
    headers[name] = value
  }

  outgoing.writeHead(response.status, headers)
  // Send the headers now: the browser must see `text/event-stream` before the
  // first token, not when the first chunk happens to fill a buffer.
  outgoing.flushHeaders?.()

  if (response.body === null) {
    outgoing.end()
    return
  }

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      if (!outgoing.write(value)) {
        // Respect backpressure rather than growing the socket's write buffer
        // without limit when a client reads slowly.
        await new Promise<void>((resolve) => outgoing.once('drain', resolve))
      }
    }
  } catch {
    // A client that disappears mid-stream is normal, not an error worth
    // logging: `sendWebResponse` cannot do anything about it either way.
  } finally {
    reader.releaseLock()
    outgoing.end()
  }
}

/** The socket peer address, for `trustProxy: false` deployments. */
export function socketIp(incoming: IncomingMessage): string | null {
  return incoming.socket?.remoteAddress ?? null
}
