import { z } from 'zod'
import { RateLimitRuleSchema } from './primitives.js'
import { BackendEntrySchema } from './backend.js'

export const AUTH_MODES = ['none', 'optional', 'required'] as const
export const JWT_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
] as const
export const BUDGET_ACTIONS = ['message', 'error', 'degrade'] as const
export const RATE_LIMIT_STORES = ['memory', 'redis'] as const
export const PII_PATTERNS = ['email', 'phone', 'creditcard', 'iban', 'ssn'] as const

export const RateLimitSchema = z.strictObject({
  perSession: RateLimitRuleSchema.default('30/5m'),
  perIp: RateLimitRuleSchema.default('100/1h'),
  store: z
    .enum(RATE_LIMIT_STORES)
    .default('memory')
    .describe('memory is single-process only — use redis for multi-replica.'),
})

export const BudgetSchema = z.strictObject({
  maxTokensPerSession: z.number().int().positive().optional(),
  maxTokensPerDay: z.number().int().positive().optional(),
  maxUsdPerDay: z.number().positive().optional(),
  onExceeded: z.enum(BUDGET_ACTIONS).default('message'),
  degradeTo: BackendEntrySchema.optional().describe(
    'Cheaper model to switch to when onExceeded is `degrade`.',
  ),
  resetHourUtc: z.number().int().min(0).max(23).default(0),
})

/**
 * docs/08-security.md §3. `maxTokenAgeSeconds` is enforced independently of
 * `exp` so a host site that mints ten-year tokens does not accidentally create
 * a permanent bearer token.
 */
export const JwtSchema = z
  .strictObject({
    secret: z.string().optional().describe('HS* shared secret. Use ${env.*}.'),
    jwksUrl: z.string().optional().describe('For RS*/ES* verification.'),
    algorithm: z.enum(JWT_ALGORITHMS).default('HS256'),
    issuer: z.string().optional(),
    audience: z.string().optional(),
    claimsMap: z
      .record(z.string(), z.string())
      .default({})
      .describe('Maps JWT claims into ctx.identity. Unmapped claims are discarded.'),
    maxTokenAgeSeconds: z.number().int().positive().default(900),
    clockToleranceSeconds: z.number().int().min(0).default(60),
  })
  .check((ctx) => {
    if (ctx.value.secret === undefined && ctx.value.jwksUrl === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['secret'],
        message: 'JWT verification needs either `secret` (HS*) or `jwksUrl` (RS*/ES*).',
      })
    }
  })

export const AuthSchema = z.strictObject({
  mode: z.enum(AUTH_MODES).default('optional'),
  jwt: JwtSchema.optional(),
})

export const SecuritySchema = z
  .strictObject({
    publicKey: z
      .string()
      .optional()
      .describe(
        'Identifies this deployment to the widget. Not a secret — it grants nothing on its own.',
      ),
    allowedOrigins: z
      .array(z.string().min(1))
      .default([])
      .describe('Empty means same-origin only. A cross-origin sidecar must opt in explicitly.'),
    rateLimit: RateLimitSchema.prefault({}),
    budget: BudgetSchema.prefault({}),
    auth: AuthSchema.prefault({}),
    redactPii: z.boolean().default(false),
    piiPatterns: z.array(z.enum(PII_PATTERNS)).default([]),
    blockedPatterns: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'Regexes rejected in user messages. Defence in depth against the lazy attempt, not a real filter.',
      ),
    maxRequestBytes: z.number().int().positive().default(262_144),
    trustProxy: z
      .union([z.literal(false), z.number().int().min(1)])
      .default(false)
      .describe('Hop count for X-Forwarded-For. false ignores the header entirely.'),
    strictTools: z
      .boolean()
      .default(false)
      .describe('Turns the "MCP import without `allow`" warning into an error.'),
  })
  .describe('docs/02-configuration.md §12, docs/08-security.md.')

export type Security = z.output<typeof SecuritySchema>
export type Auth = z.output<typeof AuthSchema>
export type Budget = z.output<typeof BudgetSchema>
export type RateLimit = z.output<typeof RateLimitSchema>
export type AuthMode = (typeof AUTH_MODES)[number]
