/**
 * `sitebot dev` — the local loop: server, playground page, hot-reload, inspector.
 *
 * The command exists because the alternative first run is "mount a route in
 * your framework, add a script tag, restart, and hope". `sitebot dev` gives a
 * URL that already has the widget on it, so the config can be edited against a
 * live assistant before any of that is wired up.
 *
 * Three things it does that `serve` does not:
 *
 * - **Serves a playground page** at `/`, with the widget already embedded.
 * - **Hot-reloads the config.** Editing the YAML rebuilds the engine in place.
 *   A config change is the thing being iterated on; making the developer
 *   restart for it would be the whole friction this command removes.
 * - **Inspects requests.** Method, path, status, duration, and — with
 *   `--inspect` — the stream events themselves.
 */

import { readFile, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { DEFAULT_BASE_PATH } from '@sitebot/server'
import { findConfigFile } from '@sitebot/config/node'
import type { ResolvedConfig } from '@sitebot/config'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FlagSpecs } from '../args.js'
import { formatMs, type Ui } from '../terminal.js'
import { WIDGET_CDN_URL } from '../init/templates.js'
import { startListener, PortInUseError, untilShutdown, type RunningServer } from './listener.js'
import {
  loadForCommand,
  reportConfigError,
  type CommandContext,
  type CommandResult,
} from './context.js'

export const DEV_FLAGS: FlagSpecs = {
  port: {
    type: 'number',
    summary: 'Port to listen on. Default 3000.',
    short: 'p',
    placeholder: '<n>',
  },
  host: { type: 'string', summary: 'Interface to bind. Default localhost.', placeholder: '<host>' },
  'base-path': {
    type: 'string',
    summary: `Where the endpoints are mounted. Default ${DEFAULT_BASE_PATH}.`,
    placeholder: '<path>',
  },
  open: { type: 'boolean', summary: 'Open the playground page in a browser.' },
  inspect: { type: 'boolean', summary: 'Log request bodies and stream events.' },
  'no-watch': { type: 'boolean', summary: 'Do not hot-reload on config changes.' },
}

export const DEFAULT_DEV_PORT = 3000

export async function runDev(context: CommandContext): Promise<CommandResult> {
  const { ui, flags, cwd } = context

  let loaded
  try {
    loaded = await loadForCommand(context)
  } catch (error) {
    return { exitCode: reportConfigError(ui, error) }
  }

  const basePath = normaliseBasePath(
    typeof flags['base-path'] === 'string' ? flags['base-path'] : DEFAULT_BASE_PATH,
  )
  const port = typeof flags['port'] === 'number' ? flags['port'] : DEFAULT_DEV_PORT
  const host = typeof flags['host'] === 'string' ? flags['host'] : 'localhost'
  const inspect = flags['inspect'] === true

  const widget = resolveWidgetBundle(cwd)

  let running: RunningServer
  try {
    running = await startListener({
      config: loaded.config,
      basePath,
      host,
      port,
      version: 'dev',
      extraRoutes: (request, response) => devRoutes(request, response, { basePath, widget }),
      onResponse: ({ method, url, status, durationMs }) => {
        if (!url.startsWith(basePath)) return
        const colour = status >= 500 ? 'red' : status >= 400 ? 'yellow' : 'green'
        ui.line(
          `  ${ui.style(String(status), colour)} ${method.padEnd(7)} ${url} ${ui.style(formatMs(durationMs), 'dim')}`,
        )
      },
      ...(inspect
        ? {
            onStreamFrame: ({ type, raw }: { type: string; raw: string }) => {
              // Frames are truncated: a text delta stream would otherwise bury
              // the tool calls and errors that are the reason to be watching.
              const body = raw.length > 160 ? `${raw.slice(0, 160)}…` : raw
              ui.line(`      ${ui.style(type.padEnd(18), 'cyan')} ${ui.style(body, 'dim')}`)
            },
          }
        : {}),
    })
  } catch (error) {
    if (error instanceof PortInUseError) {
      ui.fatal(error.message, 'Pass --port to use another.')
      return { exitCode: 1 }
    }
    ui.fatal(error instanceof Error ? error.message : String(error))
    return { exitCode: 1 }
  }

  ui.line()
  ui.success(`sitebot dev — ${ui.style(running.url, 'cyan')}`)
  ui.detail('Playground:', `${running.url}/`)
  ui.detail('Endpoint:  ', `${running.url}${basePath}`)
  ui.detail('Widget:    ', widget === null ? `${WIDGET_CDN_URL} (CDN)` : `${widget} (local)`)
  if (inspect) ui.detail('Inspector: ', 'on — request bodies and stream events are logged')
  ui.line()

  const watcher =
    flags['no-watch'] === true
      ? null
      : await watchConfig(context, loaded.config, ui, async (config) => {
          await running.reload(config)
        })

  if (flags['open'] === true) await openBrowser(`${running.url}/`)

  const shutdown = untilShutdown()
  await shutdown.promise
  ui.line()
  watcher?.close()
  await running.close()
  ui.success('Stopped.')
  return { exitCode: 0 }
}

// ── the playground page ─────────────────────────────────────────────────────

interface DevRouteOptions {
  basePath: string
  widget: string | null
}

/** The widget entry and its sibling chunks — nothing else is served from disk. */
const WIDGET_ASSET = /^\/sitebot(-[a-z][\da-z-]*)?\.js$/

async function devRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  options: DevRouteOptions,
): Promise<boolean> {
  const path = (request.url ?? '/').split('?')[0] ?? '/'

  if (path === '/' || path === '/index.html') {
    send(response, 200, 'text/html; charset=utf-8', playgroundPage(options))
    return true
  }

  // The widget from node_modules, so the local page tests the local build
  // rather than whatever the CDN is currently serving. `/sitebot-*.js` covers
  // the lazy panel chunk (docs/07 §1), which the entry pulls in by name from
  // the same directory the moment the panel first opens.
  if (WIDGET_ASSET.test(path) && options.widget !== null) {
    const file = resolve(dirname(options.widget), path.slice(1))
    const source = await readFile(file, 'utf8').catch(() => null)
    if (source !== null) {
      send(response, 200, 'text/javascript; charset=utf-8', source)
      return true
    }
  }

  return false
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * A deliberately plain host page.
 *
 * It has real headings and paragraphs because page-context extraction
 * (docs/03-protocol.md §10) reads the page, and a blank page would make the
 * assistant look broken in exactly the way that is hardest to debug. The
 * styling is minimal on purpose: this is a page for looking at the widget.
 */
function playgroundPage(options: DevRouteOptions): string {
  const src = options.widget === null ? WIDGET_CDN_URL : '/sitebot.js'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SiteBot dev</title>
<meta name="description" content="Local playground page for the SiteBot assistant.">
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.6 system-ui, sans-serif;
    max-width: 44rem;
    margin: 0 auto;
    padding: 4rem 1.5rem 8rem;
  }
  h1 { font-size: 1.8rem; margin-bottom: .25rem; }
  p.lede { color: color-mix(in srgb, currentColor 65%, transparent); margin-top: 0; }
  code { font-size: .9em; padding: .1em .35em; border-radius: 4px;
         background: color-mix(in srgb, currentColor 10%, transparent); }
  section { margin-top: 2.5rem; }
  ul { padding-left: 1.2rem; }
</style>
</head>
<body>
  <main>
    <h1>SiteBot dev playground</h1>
    <p class="lede">The launcher is in the corner. This page is served by <code>sitebot dev</code>.</p>

    <section>
      <h2>What you are looking at</h2>
      <p>
        The widget below is talking to the engine built from your config file.
        Editing that file reloads the engine in place — no restart, no lost port.
        The terminal prints one line per request, so you can watch the guards,
        the model call and the stream without opening devtools.
      </p>
    </section>

    <section>
      <h2>Page context</h2>
      <p>
        The assistant can see this page's text, because <code>prompt.includePageContext</code>
        is on by default. Ask it what this page says — if it cannot tell you,
        page-context extraction is not reaching it, and that is worth knowing now
        rather than after you have embedded the widget in a real site.
      </p>
    </section>

    <section>
      <h2>Next</h2>
      <ul>
        <li>Edit your config and watch this page pick it up.</li>
        <li>Run <code>sitebot validate</code> to see every default made explicit.</li>
        <li>Run <code>sitebot doctor</code> before you deploy.</li>
      </ul>
    </section>
  </main>

  <script type="module" src="${src}" data-endpoint="${options.basePath}"></script>
</body>
</html>
`
}

// ── hot reload ──────────────────────────────────────────────────────────────

/**
 * Watch the config file and everything it extends.
 *
 * Editors write files in ways that produce two or three events for one save —
 * truncate, write, rename — so changes are debounced. A config that fails to
 * validate keeps the previous engine running and prints the error: a typo
 * mid-edit should not take the dev server down.
 */
async function watchConfig(
  context: CommandContext,
  initial: ResolvedConfig,
  ui: Ui,
  apply: (config: ResolvedConfig) => Promise<void>,
): Promise<{ close: () => void } | null> {
  const entry =
    initial.$meta.sourcePath ??
    (typeof context.flags['config'] === 'string'
      ? resolve(context.cwd, context.flags['config'])
      : await findConfigFile(context.cwd))

  if (entry === null) return null

  const watched = [entry, ...initial.$meta.extendsChain]
  const watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | null = null
  let reloading = false

  const trigger = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      void reload()
    }, 120)
  }

  const reload = async (): Promise<void> => {
    if (reloading) return
    reloading = true
    try {
      const { config, warnings } = await loadForCommand(context)
      await apply(config)
      ui.success(`Reloaded ${relativeTo(context.cwd, entry)}`)
      for (const warning of warnings) ui.warn(`${warning.path}: ${warning.message}`)
    } catch (error) {
      ui.fail('Config change rejected — the running engine is unchanged.')
      ui.line(indent(error instanceof Error ? error.message : String(error)))
    } finally {
      reloading = false
    }
  }

  for (const file of watched) {
    if (
      !(await stat(file)
        .then(() => true)
        .catch(() => false))
    )
      continue
    try {
      // Watch the directory, not the file: editors that save by rename break a
      // file watcher's inode, and the watcher goes silent with no error.
      const watcher = watch(dirname(file), { persistent: false }, (_event, filename) => {
        if (filename === null || !watched.some((path) => path.endsWith(filename))) return
        trigger()
      })
      watchers.push(watcher)
    } catch {
      // Watching is a convenience; a platform that will not do it is not fatal.
    }
  }

  if (watchers.length === 0) return null
  ui.detail('Watching: ', watched.map((file) => relativeTo(context.cwd, file)).join(', '))

  return {
    close: () => {
      if (timer !== null) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * The widget bundle from the project's own `node_modules`, if it is there.
 *
 * Falls back to the CDN rather than failing: `sitebot dev` has to work in a
 * project that has not installed the widget yet, which is precisely the state a
 * developer is in the first time they run it.
 */
function resolveWidgetBundle(cwd: string): string | null {
  try {
    const require = createRequire(resolve(cwd, 'noop.js'))
    return require.resolve('@sitebot/widget/sitebot.js')
  } catch {
    return null
  }
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  const command =
    process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // Not being able to open a browser is not a reason to stop the server.
  }
}

function relativeTo(cwd: string, path: string): string {
  return path.startsWith(cwd) ? path.slice(cwd.length).replace(/^[\\/]/, '') : path
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

function normaliseBasePath(value: string): string {
  const withLeading = value.startsWith('/') ? value : `/${value}`
  return withLeading.replace(/\/+$/, '') || DEFAULT_BASE_PATH
}
