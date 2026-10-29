// A separate dependency-free entry: safe in the launcher, without schema/loader code.
import { en, type Catalog, type MessageKey } from './en.js'
import { fr } from './fr.js'
import { localeTables as localized, type LocaleConfig } from './locale.js'
export * from './locale.js'
export { en, fr }
export type { Catalog, MessageKey }
export const catalogs: Readonly<Record<string, Catalog>> = { en, fr }
export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

export function createTranslator(config: LocaleConfig, locale: string): Translate {
  const fallback = config.locale === 'auto' ? 'en' : (config.locale ?? 'en')
  const table: Catalog = Object.assign(
    {},
    en,
    ...localized(catalogs, fallback),
    ...localized(config.strings, fallback),
    ...localized(catalogs, locale),
    ...localized(config.strings, locale),
  )
  return (key, values) => {
    const template = table[key]
    return values
      ? template.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match))
      : template
  }
}

/** Runtime catalog checks also validate YAML overrides and interpolation parity. */
export function validateCatalog(table: Record<string, string>, complete = true): string[] {
  const problems: string[] = []
  for (const key of Object.keys(table)) {
    if (!Object.hasOwn(en, key)) {
      problems.push(`Unknown message key: ${key}`)
      continue
    }
    const placeholders = (value: string) =>
      [...new Set(value.match(/\{\w+\}/g) ?? [])].sort().join(',')
    if (placeholders(table[key] ?? '') !== placeholders(en[key as MessageKey]))
      problems.push(`Interpolation placeholders differ for ${key}`)
  }
  if (complete)
    for (const key of Object.keys(en))
      if (!Object.hasOwn(table, key)) problems.push(`Missing message key: ${key}`)
  return problems
}
