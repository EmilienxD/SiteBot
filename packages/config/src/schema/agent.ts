import { z } from 'zod'
import { ToolNameSchema } from './primitives.js'

export const MODES = ['chat', 'agent'] as const
export const APPROVAL_POLICIES = ['always', 'once-per-session', 'never'] as const
export const ON_MAX_STEPS = ['summarize', 'error', 'silent'] as const
export const TOOL_CHOICES = ['auto', 'required', 'none'] as const

export const StopWhenSchema = z.strictObject({
  steps: z.number().int().positive().optional().describe('Defaults to agent.maxSteps.'),
  tokens: z.number().int().positive().default(20_000).describe('Cumulative across the loop.'),
  seconds: z
    .number()
    .int()
    .positive()
    .default(120)
    .describe(
      'Cumulative active server time across the run; excludes approval and client-tool waits.',
    ),
})

const AgentBaseSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(32).default(8).describe('Hard ceiling on loop iterations.'),
  approvalRequired: z
    .array(ToolNameSchema)
    .default([])
    .describe(
      'Tool names that need explicit user approval. Unioned with per-tool requiresApproval.',
    ),
  approvalPolicy: z.enum(APPROVAL_POLICIES).default('always'),
  stopWhen: StopWhenSchema.prefault({}),
  onMaxSteps: z
    .enum(ON_MAX_STEPS)
    .default('summarize')
    .describe('summarize reserves the final permitted call for an answer with tools disabled.'),
  parallelToolCalls: z.boolean().default(true),
  toolChoice: z.enum(TOOL_CHOICES).default('auto'),
})

/**
 * docs/02-configuration.md §7. Ignored entirely when `mode: chat`.
 *
 * `stopWhen.steps` defaults to `maxSteps`, which Zod cannot express as a field
 * default because it reads a sibling — hence the transform. Resolving it here
 * rather than in the engine keeps `sitebot validate`'s promise that the printed
 * config is exactly what will run.
 */
export const AgentSchema = AgentBaseSchema.describe('docs/02-configuration.md §7.').transform(
  (agent) => ({
    ...agent,
    stopWhen: {
      ...agent.stopWhen,
      steps: agent.stopWhen.steps ?? agent.maxSteps,
    },
  }),
)

export type Agent = z.output<typeof AgentSchema>
