import { launcherCatalogs } from './launcher-catalogs.js'

export const DEFAULT_SUPPORTED_LOCALES: readonly string[] = Object.keys(launcherCatalogs)

/** Locale-only entry: no full catalogs, schema, parsers or server configuration. */
export interface LocaleConfig {
  locale?: string
  supportedLocales?: readonly string[]
  strings?: Record<string, Record<string, string | undefined>>
}

export function normalizeLocale(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 100 || !value.trim()) return undefined
  try {
    return Intl.getCanonicalLocales(value.trim())[0]
  } catch {
    return undefined
  }
}

/** Most specific tag first, then its parents (fr-CA → fr). */
export function localeChain(value: string): string[] {
  const tag = normalizeLocale(value)
  if (!tag) return []
  const parts = tag.split('-')
  const out: string[] = []
  while (parts.length) {
    out.push(parts.join('-'))
    parts.pop()
    // An extension singleton is not a complete language tag.
    if (parts.at(-1)?.length === 1) parts.pop()
  }
  return out
}

/** Explicit host, host document, browser preferences, configured fallback. */
export function resolveLocale(
  config: LocaleConfig,
  preferences: { override?: string; document?: string; browser?: readonly string[] } = {},
): string {
  const supported = (config.supportedLocales ?? DEFAULT_SUPPORTED_LOCALES)
    .map(normalizeLocale)
    .filter((tag): tag is string => tag !== undefined)
  const match = (value: string | undefined | null) => {
    if (!value || value === 'auto') return undefined
    return localeChain(value).find((tag) => supported.includes(tag))
  }
  // A valid but unsupported authoritative choice uses the deployment fallback,
  // rather than unexpectedly switching to the browser's language.
  const selected = [preferences.override, preferences.document].find(
    (value) => normalizeLocale(value) !== undefined,
  )
  const preferred =
    selected === undefined
      ? preferences.browser?.map(match).find((value) => value !== undefined)
      : match(selected)
  return (
    preferred ??
    match(config.locale === 'auto' || config.locale === undefined ? 'en' : config.locale) ??
    supported[0] ??
    'en'
  )
}

function localized<T>(tables: Record<string, T> | undefined, locale: string): T[] {
  if (!tables) return []
  const normalized = new Map(
    Object.entries(tables).map(([tag, table]) => [normalizeLocale(tag), table]),
  )
  return localeChain(locale)
    .reverse()
    .flatMap((tag) => {
      const table = normalized.get(tag)
      return table === undefined ? [] : [table]
    })
}
export { localized as localeTables }
