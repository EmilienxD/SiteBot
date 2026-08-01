import { z } from 'zod'

export const RouteSchema = z.strictObject({
  path: z.string().min(1).describe('Path on the site, e.g. /pricing.'),
  summary: z.string().optional().describe('What a visitor finds there.'),
})

export const GlossaryEntrySchema = z.strictObject({
  term: z.string().min(1),
  definition: z.string().min(1),
})

/**
 * Layer 1 of the knowledge stack (docs/06-knowledge.md §1): hand-written facts,
 * always in the prompt, no infrastructure. `routes` doubles as the allowlist
 * for the builtin `navigate` client tool — the model cannot send the user
 * anywhere that is not declared here.
 */
export const SiteContextSchema = z
  .strictObject({
    company: z.string().optional(),
    description: z.string().optional(),
    primaryUrl: z.string().optional(),
    supportUrl: z.string().optional(),
    tone: z.string().optional(),
    facts: z.array(z.string()).default([]),
    routes: z.array(RouteSchema).default([]),
    glossary: z.array(GlossaryEntrySchema).default([]),
  })
  .describe('docs/02-configuration.md §6.')

export type SiteContext = z.output<typeof SiteContextSchema>
