import type { Ui } from '@sitebot/config'

/**
 * Every user-visible string the panel renders, with its English default.
 * `ui.strings.<locale>.<key>` overrides any of them (docs/02 §11), and the
 * `greeting`, `placeholder` and `errorMessage` keys override the matching
 * `ui.messages` values so a localised deployment needs only the one block.
 */
export const DEFAULT_STRINGS = {
  send: 'Send message',
  stop: 'Stop response',
  close: 'Close chat',
  back: 'Back',
  message: 'Message',
  retry: 'Retry',
  retryIn: 'Retry in {seconds}s',
  stillWorking: 'Still working…',
  typing: 'Assistant is typing',
  providerError: "I'm having trouble right now.",
  budgetExceeded: 'The assistant has reached its usage limit for now. Please try again later.',
  runExpired: 'This request timed out.',
  offline: "Couldn't reach the assistant.",
  jumpToLatest: 'Jump to latest',
  attachFile: 'Attach file',
  thinking: 'Thinking',
  sources: 'Sources',
  source: 'Source {n}: {title}',
  helpful: 'Helpful',
  notHelpful: 'Not helpful',
  approvalTitle: 'Approval required',
  approvalBody: '{tool} wants to run.',
  approve: 'Approve',
  deny: 'Deny',
  details: 'Show details',
  toolRunning: 'Running',
  toolDone: 'Done',
  toolFailed: 'Failed',
  toolDenied: 'Denied',
  toolExpired: 'Timed out',
  toolSkipped: 'Skipped',
  toolApproval: 'Needs approval',
  handoff: 'Connected to {target}',
  openHandoff: 'Open conversation',
} as const

export type StringKey = keyof typeof DEFAULT_STRINGS | 'greeting' | 'placeholder' | 'errorMessage'
export type Translate = (key: StringKey, values?: Record<string, string | number>) => string

/** Resolve `ui.locale` (`auto` → the browser's) and build the lookup. */
export function createStrings(ui: Ui): Translate {
  const locale =
    ui.locale === 'auto'
      ? typeof navigator === 'undefined'
        ? 'en'
        : navigator.language
      : ui.locale
  const table = {
    ...(ui.strings[locale.split('-')[0] ?? ''] ?? {}),
    ...(ui.strings[locale] ?? {}),
  }
  const fallback: Record<string, string | undefined> = {
    ...DEFAULT_STRINGS,
    greeting: ui.messages.greeting,
    placeholder: ui.messages.placeholder,
    errorMessage: ui.messages.errorMessage,
  }
  return (key, values) => {
    const template = table[key] ?? fallback[key] ?? ''
    return values
      ? template.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match))
      : template
  }
}
