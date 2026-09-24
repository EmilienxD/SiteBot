import {
  didYouMean,
  PROVIDER_PACKAGES,
  PROVIDERS,
  providerInstallSpec,
  type ProviderId,
} from '@sitebot/config'
import type { Backend, BackendEntry } from '@sitebot/config'
import type { LanguageModel } from 'ai'
import { EngineError } from '../stream/errors.js'
import { ADAPTERS, type ProviderFactory } from './adapters.js'

/**
 * Config → an AI SDK `LanguageModel` — docs/04-providers-and-engine.md §2.
 */

export interface ResolvedModel {
  model: LanguageModel
  /** `provider:model`, used in telemetry, `/health` and pricing lookups. */
  id: string
  entry: BackendEntry
}

export interface ResolveOptions {
  /** Override the adapter table. Tests inject a stub; nothing else should. */
  adapters?: Partial<Record<ProviderId, ProviderFactory>>
  /** The config file's directory, for `provider: custom` modules. */
  baseDir?: string | null | undefined
}

export async function resolveModel(
  cfg: BackendEntry,
  options: ResolveOptions = {},
): Promise<ResolvedModel> {
  const factory = options.adapters?.[cfg.provider] ?? ADAPTERS[cfg.provider]
  if (factory === undefined) {
    const suggestion = didYouMean(cfg.provider, [...PROVIDERS])
    throw new EngineError('not_ready', {
      message:
        `Unknown provider "${cfg.provider}".` +
        (suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`),
    })
  }

  const model = await factory(cfg, { baseDir: options.baseDir })
  // ai@6 runs model spec v2 and v3. A provider package from another release
  // line fails deep inside streamText with a message about "AI SDK 5"; saying
  // which package and which range here is the difference between a fix and a
  // search.
  const spec = (model as { specificationVersion?: unknown }).specificationVersion
  if (typeof spec === 'string' && spec !== 'v2' && spec !== 'v3') {
    const pkg = PROVIDER_PACKAGES[cfg.provider]
    throw new EngineError('not_ready', {
      message:
        `The installed ${pkg ?? 'provider package'} implements model spec ${spec}, which this SiteBot build cannot run.` +
        (pkg === null
          ? ''
          : `\n  Install the compatible line:  pnpm add ${providerInstallSpec(pkg)}`),
    })
  }
  return { model, id: `${cfg.provider}:${cfg.model}`, entry: cfg }
}

/**
 * The schema defaults for the fields a fallback entry inherits.
 *
 * docs/04 §3 rule 4 says a fallback entry inherits the primary's settings
 * "unless it overrides them", but by the time config reaches us Zod has already
 * filled in defaults, so `maxOutputTokens: 2048` on a fallback is
 * indistinguishable from an unset one. Treating "still at the schema default"
 * as "not overridden" is the only reading that makes the rule observable, and
 * it fails in the harmless direction: a fallback that explicitly restates the
 * default gets the primary's value instead.
 */
export const BACKEND_ENTRY_DEFAULTS = {
  maxOutputTokens: 2048,
  timeoutMs: 60_000,
  maxRetries: 2,
} as const

/**
 * Flatten `backend` into the ordered list of entries the chain will try.
 * Element 0 is always the primary.
 */
export function resolveChain(backend: Backend): BackendEntry[] {
  const { fallback, pricing: _pricing, ...primary } = backend
  return [primary, ...fallback.map((entry) => inherit(entry, primary))]
}

function inherit(entry: BackendEntry, primary: BackendEntry): BackendEntry {
  const merged: BackendEntry = { ...entry }

  // Genuinely optional: undefined means "not set", so inheritance is exact.
  merged.temperature = entry.temperature ?? primary.temperature
  merged.topP = entry.topP ?? primary.topP
  merged.topK = entry.topK ?? primary.topK

  // Defaulted: see BACKEND_ENTRY_DEFAULTS.
  if (entry.maxOutputTokens === BACKEND_ENTRY_DEFAULTS.maxOutputTokens) {
    merged.maxOutputTokens = primary.maxOutputTokens
  }
  if (entry.timeoutMs === BACKEND_ENTRY_DEFAULTS.timeoutMs) {
    merged.timeoutMs = primary.timeoutMs
  }
  if (entry.maxRetries === BACKEND_ENTRY_DEFAULTS.maxRetries) {
    merged.maxRetries = primary.maxRetries
  }

  // An API key is provider-specific, so it is never inherited; headers are
  // additive, with the fallback's own winning on conflict.
  merged.headers = { ...primary.headers, ...entry.headers }

  return merged
}
