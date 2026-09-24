import type { ResolvedConfig } from '@sitebot/config'
import type { UIMessage } from 'ai'
import type { RequestContext } from './types.js'

/**
 * Lifecycle hooks — docs/04-providers-and-engine.md §9.
 *
 * Code-only (`chatbot.config.ts`). The schema accepts any function under these
 * names; the shapes below are what the engine passes and honours.
 */
export interface ToolCallInfo {
  name: string
  input: unknown
}

export interface StepInfo {
  finishReason: string
  text: string
  toolCalls: ToolCallInfo[]
  usage: { inputTokens: number; outputTokens: number }
}

export interface FinishInfo {
  model: string
  finishReason: string
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
}

type MaybePromise<T> = T | Promise<T>

export interface SiteBotHooks {
  /** Runs before anything else. Return a Response to answer early; throw to reject. */
  onRequest?: (request: Request, ctx: RequestContext) => MaybePromise<Response | void>
  /** Rewrite or annotate the incoming user message. */
  onMessage?: (message: UIMessage, ctx: RequestContext) => MaybePromise<UIMessage | void>
  /** Final say on the composed system prompt. */
  onPromptComposed?: (prompt: string, ctx: RequestContext) => MaybePromise<string | void>
  /** Before a server-side tool runs. Return anything but `undefined` to use it as the result. */
  onToolCall?: (call: ToolCallInfo, ctx: RequestContext) => MaybePromise<unknown>
  onStep?: (step: StepInfo, ctx: RequestContext) => MaybePromise<void>
  onFinish?: (result: FinishInfo, ctx: RequestContext) => MaybePromise<void>
  onError?: (error: unknown, ctx: RequestContext) => MaybePromise<void>
  onFeedback?: (feedback: Record<string, unknown>, ctx?: RequestContext) => MaybePromise<void>
}

export function hooksOf(config: ResolvedConfig): SiteBotHooks {
  return (config.hooks ?? {}) as SiteBotHooks
}

type HookName = Exclude<keyof SiteBotHooks, 'onRequest'>

/**
 * Run a hook. A throwing hook is logged and ignored: a bug in the developer's
 * analytics must not take the chat down. Only `onRequest` may reject a
 * request, and it is called directly by the server handler, not through here.
 */
export async function runHook<K extends HookName>(
  hooks: SiteBotHooks,
  name: K,
  ctx: RequestContext,
  ...args: Parameters<NonNullable<SiteBotHooks[K]>>
): Promise<Awaited<ReturnType<NonNullable<SiteBotHooks[K]>>> | undefined> {
  const hook = hooks[name] as ((...params: unknown[]) => unknown) | undefined
  if (hook === undefined) return undefined
  try {
    return (await hook(...args)) as Awaited<ReturnType<NonNullable<SiteBotHooks[K]>>>
  } catch (error) {
    ctx.logger.error(`${name} hook threw`, { error })
    return undefined
  }
}

const reported = new WeakMap<RequestContext, Set<unknown>>()

/**
 * `onError`, once per error per request. A provider failure surfaces twice —
 * from the stream, then wrapped as the request's error — and a developer's
 * error reporter should count it once.
 */
export function reportError(hooks: SiteBotHooks, error: unknown, ctx: RequestContext): void {
  if (hooks.onError === undefined) return
  const seen = reported.get(ctx) ?? new Set<unknown>()
  reported.set(ctx, seen)
  const cause = (error as { cause?: unknown } | null)?.cause
  if (seen.has(error) || (cause !== undefined && seen.has(cause))) return
  seen.add(error)
  void runHook(hooks, 'onError', ctx, error, ctx)
}
