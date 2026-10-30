import type { ResolvedConfig } from '@sitebot/config'
import type { RequestContext } from '../types.js'
import { withDeadline, checkDeadline } from '../deadline.js'
import { EngineError } from '../stream/errors.js'

/** One invocation per incoming generation request, before any model operation. */
export async function resolveSystem(config: ResolvedConfig, ctx: RequestContext): Promise<string> {
  try {
    return await withDeadline(config.prompt.systemTimeoutMs, ctx.signal, async (signal) => {
      const source = config.prompt.system
      const text =
        typeof source === 'function'
          ? await source({
              identity: ctx.identity === null ? null : structuredClone(ctx.identity),
              locale: ctx.locale,
              requestId: ctx.requestId,
              sessionId: ctx.sessionId,
              signal,
              untrustedPageContext:
                ctx.pageContext === null ? null : { ...structuredClone(ctx.pageContext) },
            })
          : source
      checkDeadline(signal)
      checkDeadline(signal)
      if (typeof text !== 'string' || text.trim() === '') throw new Error()
      return text
    })
  } catch {
    // No cause/detail: even debug responses must not expose application loading errors.
    throw new EngineError(ctx.signal.aborted ? 'aborted' : 'not_ready')
  }
}
