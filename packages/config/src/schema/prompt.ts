import { z } from 'zod'

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
    includePageContext: z.boolean().default(true),
    includeSiteContext: z.boolean().default(true),
    variables: z
      .record(z.string(), z.string())
      .default({})
      .describe('Values for {{name}} placeholders in `system`.'),
    guardrails: GuardrailsSchema.prefault({}),
  })
  .describe('docs/02-configuration.md §5.')
  .check((ctx) => {
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
  })

export type Prompt = z.output<typeof PromptSchema>
