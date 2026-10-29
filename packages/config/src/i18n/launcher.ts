import { localeTables, type LocaleConfig } from './locale.js'

import { launcherCatalogs } from './launcher-catalogs.js'
export { launcherCatalogs } from './launcher-catalogs.js'
export function createLauncherStrings(
  config: LocaleConfig & { a11y?: { launcherAriaLabel?: string } },
  locale: string,
) {
  const fallback = config.locale === 'auto' ? 'en' : (config.locale ?? 'en')
  const table = Object.assign(
    {},
    launcherCatalogs.en,
    ...localeTables(launcherCatalogs, fallback),
    ...localeTables(config.strings, fallback),
    ...localeTables(launcherCatalogs, locale),
    ...localeTables(config.strings, locale),
  )
  return (key: keyof typeof launcherCatalogs.en) => {
    const custom = config.a11y?.launcherAriaLabel
    const overridden = [
      ...localeTables(config.strings, fallback),
      ...localeTables(config.strings, locale),
    ].some((copy) => copy[key] !== undefined)
    return key === 'launcherAriaLabel' &&
      custom !== undefined &&
      custom !== launcherCatalogs.en.launcherAriaLabel &&
      !overridden
      ? custom
      : (table[key] ?? '')
  }
}
