import { z } from 'zod'

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const
export const TELEMETRY_EVENTS = [
  'message',
  'tool_call',
  'error',
  'finish',
  'approval',
  'feedback',
  'provider_fallback',
  'budget_exceeded',
] as const

export const OtelSchema = z.strictObject({
  enabled: z.boolean().default(false),
  serviceName: z.string().min(1).default('sitebot'),
})

/**
 * Nothing is sent anywhere unless `events.webhook` is set — we do not phone
 * home (docs/08-security.md §9).
 */
export const EventsSchema = z.strictObject({
  webhook: z.string().optional().describe("The developer's own endpoint. No webhook, no events."),
  include: z.array(z.enum(TELEMETRY_EVENTS)).default(['message', 'tool_call', 'error', 'finish']),
})

export const TelemetrySchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    otel: OtelSchema.prefault({}),
    events: EventsSchema.prefault({}),
    logLevel: z.enum(LOG_LEVELS).default('info'),
    redactPromptsInLogs: z.boolean().default(true),
  })
  .describe('docs/02-configuration.md §13.')

export type Telemetry = z.output<typeof TelemetrySchema>
