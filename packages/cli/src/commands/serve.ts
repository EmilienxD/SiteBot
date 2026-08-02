/**
 * `sitebot serve` — the production sidecar, topology T2.
 *
 * The deployment for sites that are not Node applications: a Django, Rails or
 * WordPress host page loads the widget, and this process answers `/api/chat`
 * from its own origin. That makes CORS load-bearing rather than incidental,
 * which is why an empty `security.allowedOrigins` is a startup warning here and
 * nowhere else — same-origin-only is the correct default for an embedded route
 * and a guaranteed outage for a sidecar.
 */

import { DEFAULT_BASE_PATH } from '@sitebot/server'
import type { FlagSpecs } from '../args.js'
import { startListener, PortInUseError, untilShutdown } from './listener.js'
import { loadForCommand, reportConfigError, type CommandContext, type CommandResult } from './context.js'

export const SERVE_FLAGS: FlagSpecs = {
  port: { type: 'number', summary: 'Port to listen on. Default 8787.', short: 'p', placeholder: '<n>' },
  host: { type: 'string', summary: 'Interface to bind. Default 0.0.0.0.', placeholder: '<host>' },
  'base-path': {
    type: 'string',
    summary: `Where the endpoints are mounted. Default ${DEFAULT_BASE_PATH}.`,
    placeholder: '<path>',
  },
}

export const DEFAULT_SERVE_PORT = 8787

export async function runServe(context: CommandContext): Promise<CommandResult> {
  const { ui, flags, env } = context

  let loaded
  try {
    loaded = await loadForCommand(context)
  } catch (error) {
    return { exitCode: reportConfigError(ui, error) }
  }

  const { config } = loaded
  const basePath = normaliseBasePath(
    typeof flags['base-path'] === 'string' ? flags['base-path'] : DEFAULT_BASE_PATH,
  )
  // PORT is what every PaaS injects, so honouring it is what makes `sitebot
  // serve` deployable without a wrapper script.
  const port =
    typeof flags['port'] === 'number' ? flags['port'] : Number(env['PORT'] ?? DEFAULT_SERVE_PORT)
  const host = typeof flags['host'] === 'string' ? flags['host'] : (env['HOST'] ?? '0.0.0.0')

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    ui.fatal(`"${String(port)}" is not a valid port.`)
    return { exitCode: 1 }
  }

  let running
  try {
    running = await startListener({
      config,
      basePath,
      host,
      port,
      onResponse: ({ method, url, status, durationMs }) => {
        // One line per request, in a shape a log aggregator can parse.
        ui.line(
          JSON.stringify({
            t: new Date().toISOString(),
            method,
            url,
            status,
            ms: durationMs,
          }),
        )
      },
    })
  } catch (error) {
    if (error instanceof PortInUseError) {
      ui.fatal(error.message, 'Pass --port, or set PORT.')
      return { exitCode: 1 }
    }
    ui.fatal(error instanceof Error ? error.message : String(error))
    return { exitCode: 1 }
  }

  ui.success(`sitebot serve — listening on ${running.url}`)
  ui.detail('Endpoints:', `${basePath}, ${basePath}/config, ${basePath}/feedback, ${basePath}/health`)
  ui.detail('Probe:', '/health')

  if (config.security.allowedOrigins.length === 0) {
    ui.warn(
      'security.allowedOrigins is empty — cross-origin requests will be refused, and a sidecar is cross-origin by definition.',
    )
    ui.step('List the site origins that embed the widget, e.g. [https://acme.com].')
  }
  if (config.security.rateLimit.store === 'memory') {
    ui.warn('security.rateLimit.store is memory — correct for one replica only.')
  }
  if (config.security.trustProxy === false) {
    ui.warn(
      'security.trustProxy is false — behind a load balancer every request will look like it came from the proxy.',
    )
  }

  const shutdown = untilShutdown()
  const signal = await shutdown.promise
  ui.line()
  ui.info(`${signal} — draining.`)
  await running.close()
  ui.success('Stopped.')
  return { exitCode: 0 }
}

function normaliseBasePath(value: string): string {
  const withLeading = value.startsWith('/') ? value : `/${value}`
  return withLeading.replace(/\/+$/, '') || DEFAULT_BASE_PATH
}
