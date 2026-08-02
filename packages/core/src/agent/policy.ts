import { stepCountIs, type StopCondition, type ToolSet } from 'ai'
import type { ResolvedConfig } from '@sitebot/config'

/**
 * Policy resolution — docs/04-providers-and-engine.md §4.
 *
 * **This function is the only place in the codebase that branches on `mode`.**
 * That is the design, not an accident of it: "simple chatbot" and "AI agent"
 * are one engine with two policies, so every other module can be written
 * without asking which one it is serving. A `if (config.mode === 'agent')`
 * anywhere else is a bug.
 */

export interface Policy {
  stopWhen: StopCondition<ToolSet>[]
  /** Applied to the tool registry. Phase 5 gives it something to filter. */
  toolFilter: (tool: { readOnly?: boolean }) => boolean
  toolChoice: 'auto' | 'required' | 'none'
  retrieval: 'tool' | 'always' | 'hybrid'
  approvals: boolean
}

/**
 * Cumulative token ceiling across the loop. Ours — the AI SDK ships only
 * `stepCountIs`.
 */
export const tokenBudgetIs =
  (max: number): StopCondition<ToolSet> =>
  ({ steps }) =>
    steps.reduce((total, step) => total + (step.usage?.totalTokens ?? 0), 0) >= max

/**
 * Wall-clock ceiling. The deadline is captured when the condition is *built*,
 * so a policy has to be resolved per request — reusing one across requests
 * would hand the second request an already-expired deadline.
 */
export const wallClockIs = (seconds: number): StopCondition<ToolSet> => {
  const deadline = Date.now() + seconds * 1000
  return () => Date.now() >= deadline
}

export function resolvePolicy(config: ResolvedConfig): Policy {
  const enabledTools = config.tools.filter((entry) => !('from' in entry) && entry.enabled !== false)

  if (config.mode === 'chat') {
    return {
      stopWhen: [stepCountIs(1)],
      toolFilter: (tool) => tool.readOnly === true,
      toolChoice: enabledTools.length > 0 ? 'auto' : 'none',
      retrieval: config.knowledge.retrieval.mode ?? 'always',
      approvals: false,
    }
  }

  return {
    stopWhen: [
      stepCountIs(config.agent.stopWhen.steps),
      tokenBudgetIs(config.agent.stopWhen.tokens),
      wallClockIs(config.agent.stopWhen.seconds),
    ],
    toolFilter: () => true,
    toolChoice: config.agent.toolChoice,
    retrieval: config.knowledge.retrieval.mode ?? 'tool',
    approvals: true,
  }
}
