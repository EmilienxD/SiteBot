/**
 * The Node listener behind `sitebot dev` and `sitebot serve`.
 *
 * Both commands are the same server with different defaults, so the socket
 * handling, graceful shutdown and port selection live here once.
 *
 * `createNodeHandler` rather than `createServer`: the Hono app is the portable
 * one (Workers, Deno, Bun), but it takes whatever deps it is given, whereas the
 * Node adapter wires `createSafeFetch` and the Redis rate-limit store itself.
 * For a process that is going to face the internet as a sidecar, the SSRF guard
 * on `http` tools (docs/08-security.md §5) is not something to leave to the
 * caller remembering to pass it.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ResolvedConfig } from '@sitebot/config'
import { createNodeHandler, type NodeHandler } from '@sitebot/server/node'

export interface ListenerOptions {
  config: ResolvedConfig
  basePath: string
  host: string
  port: number
  version?: string
  /** Extra routes tried before the SiteBot handler. Returns true when handled. */
  extraRoutes?: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => boolean | Promise<boolean>
  onRequest?: (info: { method: string; url: string }) => void
  onResponse?: (info: { method: string; url: string; status: number; durationMs: number }) => void
  /**
   * Called for each SSE frame written back, when set.
   *
   * This is the `--inspect` half of `sitebot dev`. Tapping the socket rather
   * than the engine is deliberate: the interesting failures are the ones where
   * the engine believes it emitted something the browser never received, and a
   * tap inside the engine would agree with the engine.
   */
  onStreamFrame?: (frame: { type: string; raw: string }) => void
}

export interface RunningServer {
  server: Server
  /** The live handler. Replaced by {@link RunningServer.reload}. */
  readonly handler: NodeHandler
  port: number
  host: string
  url: string
  /**
   * Swap in a new config without dropping the socket.
   *
   * `sitebot dev` needs this for config hot-reload. Closing and re-listening
   * would work, but it races the OS reclaiming the port and drops any open SSE
   * stream in a way that looks like a crash from the browser side.
   */
  reload(config: ResolvedConfig): Promise<void>
  close(): Promise<void>
}

export class PortInUseError extends Error {
  readonly port: number
  constructor(port: number) {
    super(`Port ${port} is already in use.`)
    this.name = 'PortInUseError'
    this.port = port
  }
}

export async function startListener(options: ListenerOptions): Promise<RunningServer> {
  const build = (config: ResolvedConfig): NodeHandler =>
    createNodeHandler(config, {
      basePath: options.basePath,
      ...(options.version === undefined ? {} : { version: options.version }),
    })

  let handler = build(options.config)

  const server = createHttpServer((request, response) => {
    const started = Date.now()
    const method = request.method ?? 'GET'
    const url = request.url ?? '/'
    options.onRequest?.({ method, url })

    response.on('finish', () => {
      options.onResponse?.({
        method,
        url,
        status: response.statusCode,
        durationMs: Date.now() - started,
      })
    })

    if (options.onStreamFrame !== undefined) tapStream(response, options.onStreamFrame)

    void dispatch(request, response, handler, options).catch((error: unknown) => {
      // The handler maps its own errors; anything reaching here is the listener
      // failing, and a half-written stream cannot be turned into a JSON body.
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'internal', message: 'Server error.' } }))
      } else {
        response.end()
      }
      console.error(error instanceof Error ? error.stack : String(error))
    })
  })

  await listen(server, options.port, options.host)

  const address = server.address() as AddressInfo
  const host = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host
  return {
    server,
    get handler() {
      return handler
    },
    port: address.port,
    host: options.host,
    url: `http://${host}:${address.port}`,
    reload: async (config: ResolvedConfig) => {
      const previous = handler
      handler = build(config)
      // Dispose after the swap, never before: an in-flight request holding the
      // old handler finishes against a live engine rather than a disposed one.
      await previous.dispose()
    },
    close: async () => {
      await handler.dispose()
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
        // Keep-alive sockets from a browser tab would otherwise hold the
        // process open well past the point the developer expects it gone.
        server.closeAllConnections?.()
      })
    },
  }
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: NodeHandler,
  options: ListenerOptions,
): Promise<void> {
  if (options.extraRoutes !== undefined) {
    if (await options.extraRoutes(request, response)) return
  }

  const url = request.url ?? '/'
  const path = url.split('?')[0] ?? '/'

  // A sidecar usually sits behind a load balancer probing `/health`. Pointing
  // that probe at the real report means a broken provider takes the instance
  // out of rotation instead of quietly serving errors.
  if (path === '/health' && options.basePath !== '/') {
    const report = await handler.handler.engine.health()
    const body = JSON.stringify(report)
    response.writeHead(report.status === 'error' ? 503 : 200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
    return
  }

  if (path === options.basePath || path.startsWith(`${options.basePath}/`)) {
    await handler(request, response)
    return
  }

  notFound(response, options.basePath)
}

/**
 * Report each `data:` frame written to an SSE response.
 *
 * `write` is monkey-patched rather than piped through a Transform because the
 * handler owns the response object and a Transform in front of it would change
 * backpressure behaviour — an inspector that alters the thing it inspects is
 * worse than no inspector. The patch is pass-through: it never withholds,
 * reorders or rewrites a chunk.
 */
function tapStream(
  response: ServerResponse,
  onFrame: (frame: { type: string; raw: string }) => void,
): void {
  const original = response.write.bind(response)
  let buffer = ''

  response.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')

      // Frames are separated by a blank line. Anything after the last one is a
      // partial frame and stays in the buffer.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
        if (data === '') continue
        onFrame({ type: frameType(data), raw: data })
      }
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as ServerResponse['write']
}

function frameType(data: string): string {
  if (data === '[DONE]') return 'done'
  try {
    const parsed: unknown = JSON.parse(data)
    const type = (parsed as { type?: unknown }).type
    return typeof type === 'string' ? type : 'unknown'
  } catch {
    return 'raw'
  }
}

function notFound(response: ServerResponse, basePath: string): void {
  const body = JSON.stringify({
    error: { code: 'not_found', message: `Nothing here. The assistant is at ${basePath}.` },
  })
  response.writeHead(404, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening)
      rejectListen(error.code === 'EADDRINUSE' ? new PortInUseError(port) : error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Resolve when the process is asked to stop.
 *
 * Both signals, because Ctrl-C sends SIGINT and a container runtime sends
 * SIGTERM, and a sidecar that ignores the second one gets SIGKILLed mid-stream.
 */
export function untilShutdown(): { promise: Promise<string>; dispose: () => void } {
  let onSignal: ((signal: string) => void) | null = null
  const promise = new Promise<string>((resolveSignal) => {
    onSignal = (signal: string) => resolveSignal(signal)
    process.once('SIGINT', () => onSignal?.('SIGINT'))
    process.once('SIGTERM', () => onSignal?.('SIGTERM'))
  })
  return { promise, dispose: () => { onSignal = null } }
}
