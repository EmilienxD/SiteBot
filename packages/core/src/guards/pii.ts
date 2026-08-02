import type { UIMessage } from 'ai'
import type { Security } from '@sitebot/config'

type PiiPattern = Security['piiPatterns'][number]

const PATTERNS: Record<PiiPattern, RegExp> = {
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  phone: /(?<!\w)(?:\+?\d[\d .()-]{7,}\d)(?!\w)/g,
  creditcard: /\b(?:\d[ -]*?){13,19}\b/g,
  iban: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi,
  ssn: /\b\d{3}-?\d{2}-?\d{4}\b/g,
}

export function redactPiiMessages(
  messages: readonly UIMessage[],
  patterns: readonly PiiPattern[],
): UIMessage[] {
  const replacements = new Map<string, string>()
  const counts = new Map<PiiPattern, number>()

  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== 'text') return part
      let text = part.text
      for (const pattern of patterns) {
        text = text.replace(PATTERNS[pattern], (value) => {
          const key = `${pattern}:${value.toLowerCase()}`
          const existing = replacements.get(key)
          if (existing !== undefined) return existing
          const count = (counts.get(pattern) ?? 0) + 1
          counts.set(pattern, count)
          const token = `[${pattern.toUpperCase()}_${count}]`
          replacements.set(key, token)
          return token
        })
      }
      return { ...part, text }
    }),
  }))
}
