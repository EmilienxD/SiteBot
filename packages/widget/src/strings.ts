import { hostLocale, localizedUi } from './locale.js'
export { hostLocale, localizedUi } from './locale.js'
import type { Ui } from '@sitebot/config'
import {
  createTranslator,
  en,
  localeTables,
  type MessageKey,
  type Translate,
} from '@sitebot/config/i18n'

export { en as DEFAULT_STRINGS }
export type StringKey = MessageKey
export type { Translate }

export function createStrings(ui: Ui, locale = hostLocale(ui)): Translate {
  const translate = createTranslator(ui, locale)
  const copy = localizedUi(ui, locale)
  const configured = {
    greeting: copy.messages.greeting,
    placeholder: copy.messages.placeholder,
    errorMessage: copy.messages.errorMessage,
    ...copy.a11y,
  }
  return (key, values) => {
    // Explicit string overrides win. Legacy schema defaults defer to the catalog.
    const overridden = [
      ...localeTables(ui.strings, ui.locale),
      ...localeTables(ui.strings, locale),
    ].some((table) => table[key] !== undefined)
    const value = configured[key as keyof typeof configured]
    if (!overridden && value !== undefined && value !== en[key])
      return values
        ? value.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match))
        : value
    return translate(key, values)
  }
}
