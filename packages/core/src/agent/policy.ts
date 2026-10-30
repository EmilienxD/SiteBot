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
  approvals: boolean
  summarizeAtStep?: number
  /**
   * The run already used every step `maxSteps` allows. A resume must end
   * without another model call, even if the model ignored toolChoice: none.
   */
  stepsExhausted?: true
  budgetExhausted?: true
}

export interface PolicyOptions {
  /**
   * Steps the run took before this request. A run suspended for a client tool
   * resumes in a new request, and the step ceiling covers the whole run, not
   * each request's share of it.
   */
  stepsTaken?: number
  tokensUsed?: number
  /** Time spent in earlier server runs; waiting for the visitor is excluded. */
  activeMs?: number
  now?: () => number
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
export const wallClockIs = (seconds: number, now = Date.now): StopCondition<ToolSet> => {
  const deadline = now() + seconds * 1000
  return () => now() >= deadline
}

export function resolvePolicy(config: ResolvedConfig, options: PolicyOptions = {}): Policy {
  const remaining =
    Math.min(config.agent.maxSteps, config.agent.stopWhen.steps) - (options.stepsTaken ?? 0)
  const tokensRemaining = config.agent.stopWhen.tokens - (options.tokensUsed ?? 0)
  const secondsRemaining = config.agent.stopWhen.seconds - (options.activeMs ?? 0) / 1000
  const summarize = config.agent.onMaxSteps === 'summarize'
  const limits = {
    // Reserve the final permitted step for a tool-less summary.
    stopWhen: [
      stepCountIs(Math.max(1, remaining)),
      tokenBudgetIs(tokensRemaining),
      wallClockIs(secondsRemaining, options.now),
    ],
    ...(summarize ? { summarizeAtStep: Math.max(0, remaining - 1) } : {}),
    ...(remaining <= 0 ? { stepsExhausted: true as const } : {}),
    ...(tokensRemaining <= 0 || secondsRemaining <= 0 ? { budgetExhausted: true as const } : {}),
  }
  if (config.mode === 'chat') {
    return {
      ...limits,
      toolFilter: (tool) => tool.readOnly === true,
      // The engine decides whether any tools survived registry construction,
      // using only explicit application registrations.
      toolChoice: config.agent.toolChoice,
      approvals: false,
    }
  }
  return {
    ...limits,
    toolFilter: () => true,
    toolChoice: config.agent.toolChoice,
    approvals: true,
  }
}
