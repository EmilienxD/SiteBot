import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * `--static <dir>` for `sitebot dev` and `sitebot serve`: serve a site's own
 * files next to the endpoints, so a plain-HTML site (docs/00 topology,
 * `examples/plain-html`) runs from one process with no build step and no
 * second server — same origin, so no CORS to configure either.
 *
 * Also serves the widget bundle at `/sitebot.js` and its sibling chunks from
 * the installed `@sitebot/widget`, which is what lets a page use a relative
 * script `src` locally and the CDN URL in production.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** The widget entry and its sibling chunks — nothing else is served from its dir. */
export const WIDGET_ASSET = /^\/sitebot(-[a-z][\da-z-]*)?\.js$/

export function resolveWidgetBundle(cwd: string): string | null {
  try {
    return createRequire(resolve(cwd, 'noop.js')).resolve('@sitebot/widget/sitebot.js')
  } catch {
    return null
  }
}

export interface StaticOptions {
  /** Site root. Requests never resolve outside it. */
  dir?: string | undefined
  /** Absolute path of `@sitebot/widget/dist/sitebot.js`, or null for none. */
  widget: string | null
  /** Paths the caller owns (the endpoints); never shadowed by a file. */
  basePath: string
  /** `no-store` in dev so edits show on reload; a short cache in serve. */
  cacheControl: string
}

export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  options: StaticOptions,
): Promise<boolean> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  let path: string
  try {
    path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/')
  } catch {
    return false
  }
  if (path === options.basePath || path.startsWith(`${options.basePath}/`)) return false

  if (WIDGET_ASSET.test(path) && options.widget !== null) {
    const file = resolve(dirname(options.widget), path.slice(1))
    // A sidecar's host page loads this as a cross-origin module script, which
    // the browser fetches in CORS mode and refuses to run without the header.
    // The bundle is public code, as on any CDN; the API's own origin
    // allowlist is what guards the endpoint.
    const cors = { 'access-control-allow-origin': '*' }
    if (await sendFile(request, response, file, options.cacheControl, cors)) return true
  }

  if (options.dir === undefined) return false
  const root = resolve(options.dir)
  const target = normalize(join(root, path))
  // Traversal guard: `normalize` collapses `..`, so anything that escaped the
  // root no longer starts with it.
  if (target !== root && !target.startsWith(root + sep)) return false
  const info = await stat(target).catch(() => null)
  const file = info?.isDirectory() ? join(target, 'index.html') : target
  if (await sendFile(request, response, file, options.cacheControl)) return true
  // `/pricing` → `pricing.html`, the way static hosts resolve clean URLs.
  if (
    extname(target) === '' &&
    (await sendFile(request, response, `${target}.html`, options.cacheControl))
  )
    return true
  return false
}

async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  cacheControl: string,
  extraHeaders: Record<string, string> = {},
): Promise<boolean> {
  const body = await readFile(file).catch(() => null)
  if (body === null) return false
  response.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  response.end(request.method === 'HEAD' ? undefined : body)
  return true
}
