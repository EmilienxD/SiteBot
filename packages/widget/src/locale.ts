import type { Ui } from '@sitebot/config'
import { localeTables, resolveLocale } from '@sitebot/config/i18n/locale'

/** Always read the host document, including when rendering into an iframe. */
export function hostLocale(ui: Ui, override?: string): string {
  return resolveLocale(ui, {
    override,
    document: typeof document === 'undefined' ? undefined : document.documentElement.lang,
    browser:
      typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language],
  })
}

/** Locale-specific deployment copy overlays the base public configuration. */
export function localizedUi(ui: Ui, locale: string): Ui {
  const fallback = ui.locale === 'auto' ? 'en' : ui.locale
  return [
    ...localeTables(ui.translations, fallback),
    ...localeTables(ui.translations, locale),
  ].reduce<Ui>(
    (out, copy) => ({
      ...out,
      messages: { ...out.messages, ...copy.messages },
      a11y: { ...out.a11y, ...copy.a11y },
      launcher: {
        ...out.launcher,
        ...copy.launcher,
        badge: { ...out.launcher.badge, ...copy.launcher?.badge },
      },
      panel: { ...out.panel, ...copy.panel },
      ...(copy.footer
        ? { footer: { ...out.footer, text: out.footer?.text ?? '', ...copy.footer } }
        : {}),
    }),
    ui,
  )
}
