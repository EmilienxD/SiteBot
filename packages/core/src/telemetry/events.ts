import type { Telemetry } from '@sitebot/config'
import type { Logger } from '../types.js'
import { redact } from './logger.js'

/**
 * Event dispatch — docs/02-configuration.md §13, docs/08-security.md §9.
 *
 * Nothing is sent anywhere unless the developer configured their own webhook.
 * We do not phone home, so there is no default endpoint to forget to disable.
 */

export type EventName =
  | 'message'
  | 'tool_call'
  | 'error'
  | 'finish'
  | 'approval'
  | 'feedback'
  | 'lead'
  | 'handoff'
  | 'provider_fallback'
  | 'budget_exceeded'

export interface TelemetryEvent {
  event: EventName
  time: number
  requestId?: string
  sessionId?: string
  data: Record<string, unknown>
}

export interface EventDispatcher {
  emit(event: EventName, data: Record<string, unknown>, meta?: EventMeta): void
  /** Resolves once every in-flight delivery has settled. Used by `dispose()`. */
  drain(): Promise<void>
}

export interface EventMeta {
  requestId?: string
  sessionId?: string
}

export interface DispatcherOptions {
  telemetry: Telemetry
  logger: Logger
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Delivery is fire-and-forget: a slow or broken webhook must not add latency to
 * a user's message, and a failed delivery is logged rather than surfaced. That
 * is a deliberate trade — telemetry is not worth degrading the product for.
 */
export function createEventDispatcher(options: DispatcherOptions): EventDispatcher {
  const { telemetry, logger } = options
  const now = options.now ?? (() => Date.now())
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const inFlight = new Set<Promise<unknown>>()

  const enabled = (event: EventName): boolean =>
    telemetry.enabled &&
    telemetry.events.webhook !== undefined &&
    telemetry.events.include.includes(event)

  return {
    emit(event, data, meta = {}) {
      if (!enabled(event)) return
      const payload: TelemetryEvent = {
        event,
        time: now(),
        ...(meta.requestId === undefined ? {} : { requestId: meta.requestId }),
        ...(meta.sessionId === undefined ? {} : { sessionId: meta.sessionId }),
        data: redact(data, { redactPrompts: telemetry.redactPromptsInLogs }) as Record<
          string,
          unknown
        >,
      }

      if (fetchImpl === undefined) {
        logger.warn('telemetry webhook configured but no fetch implementation is available')
        return
      }

      const delivery = fetchImpl(telemetry.events.webhook as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then((response) => {
          if (!response.ok) {
            logger.warn('telemetry webhook rejected the event', {
              event,
              status: response.status,
            })
          }
        })
        .catch((error: unknown) => {
          logger.warn('telemetry webhook delivery failed', { event, error })
        })
        .finally(() => {
          inFlight.delete(delivery)
        })

      inFlight.add(delivery)
    },

    async drain() {
      await Promise.allSettled([...inFlight])
    },
  }
}

/** A dispatcher that does nothing, for `telemetry.enabled: false` and tests. */
export const noopDispatcher: EventDispatcher = {
  emit: () => {},
  drain: async () => {},
}
