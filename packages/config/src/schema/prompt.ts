import { z } from 'zod'

export interface PromptResolverContext {
  /** Verified by the server authentication layer; null for anonymous requests. */
  identity: { sub: string; email?: string; [claim: string]: unknown } | null
  locale: string
  requestId: string
  sessionId: string
  signal: AbortSignal
  /** Browser-supplied data, never instructions or verified identity. */
  untrustedPageContext: Readonly<Record<string, unknown>> | null
}
export type PromptSystemResolver = (ctx: PromptResolverContext) => string | Promise<string>

/** Used when `guardrails.refuseOffTopic` is on and no message is configured. */
export const DEFAULT_OFF_TOPIC_MESSAGE = 'I can only help with questions about this site.'

export const GuardrailsSchema = z.strictObject({
  refuseOffTopic: z
    .boolean()
    .default(false)
    .describe('Appends a scoping instruction to the prompt. A soft guard, not a security control.'),
  offTopicMessage: z.string().default(DEFAULT_OFF_TOPIC_MESSAGE),
  maxUserMessageChars: z
    .number()
    .int()
    .positive()
    .default(8000)
    .describe('Messages longer than this are rejected before the model call.'),
})

export const PromptSchema = z
  .strictObject({
    system: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The system prompt. {{variables}} are substituted; ${env.*} is deliberately NOT (docs/02 §2).',
      ),
    systemFile: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Path to a file holding the system prompt, relative to the config file. Read at load time.',
      ),
    systemTimeoutMs: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(3_000)
      .describe('Deadline for server prompt.system resolution; default 3000ms, maximum 10000ms.'),
    includePageContext: z.boolean().default(true),
    includeSiteContext: z.boolean().default(true),
    variables: z
      .record(z.string(), z.string())
      .default({})
      .describe('Values for {{name}} placeholders in `system`.'),
    guardrails: GuardrailsSchema.prefault({}),
  })
  .describe('docs/02-configuration.md §5.')
  .check(checkPrompt)

function checkPrompt(ctx: z.core.ParsePayload<{ system?: unknown; systemFile?: string }>) {
  const { system, systemFile } = ctx.value
  if (system === undefined && systemFile === undefined) {
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      path: ['system'],
      message: 'prompt.system is required unless prompt.systemFile is set.',
    })
  } else if (system !== undefined && systemFile !== undefined) {
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      path: ['systemFile'],
      message: 'prompt.system and prompt.systemFile are mutually exclusive — set exactly one.',
    })
  }
}

export type Prompt = z.output<typeof PromptSchema>

export const CodePromptSchema = z
  .strictObject({
    ...PromptSchema.shape,
    system: z
      .union([
        z.string().min(1),
        z.custom<PromptSystemResolver>((value) => typeof value === 'function'),
      ])
      .optional(),
  })
  .check(checkPrompt)
