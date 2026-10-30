import { z } from 'zod'

export const RouteSchema = z.strictObject({
  path: z.string().min(1).describe('Path on the site, e.g. /pricing.'),
  summary: z.string().optional().describe('What a visitor finds there.'),
})

export const GlossaryEntrySchema = z.strictObject({
  term: z.string().min(1),
  definition: z.string().min(1),
})

/** Trusted application-provided site facts and route descriptions; no action allowlist. */
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
