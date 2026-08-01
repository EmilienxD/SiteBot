import { z } from 'zod'

export const STORAGE_TYPES = ['none', 'memory', 'sqlite', 'redis', 'postgres', 'custom'] as const

/**
 * Retention and transcript settings apply to every backend, so they are spread
 * into each branch of the union rather than sitting outside it — that way the
 * discriminated union stays flat and the editor offers the right keys as soon
 * as `type` is typed.
 */
const StorageCommonShape = {
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .default(2_592_000)
    .describe('Session retention. Default 30 days.'),
  maxMessagesPerSession: z.number().int().positive().default(100),
  persistTranscripts: z
    .boolean()
    .default(true)
    .describe(
      'false keeps only the loop state needed for resume and drops message bodies at session end.',
    ),
}

export const NoneStorageSchema = z.strictObject({
  type: z.literal('none'),
  ...StorageCommonShape,
})

export const MemoryStorageSchema = z.strictObject({
  type: z.literal('memory'),
  ...StorageCommonShape,
})

export const SqliteStorageSchema = z.strictObject({
  type: z.literal('sqlite'),
  path: z.string().min(1).default('./.sitebot/sessions.db'),
  ...StorageCommonShape,
})

export const RedisStorageSchema = z.strictObject({
  type: z.literal('redis'),
  url: z.string().min(1),
  ...StorageCommonShape,
})

export const PostgresStorageSchema = z.strictObject({
  type: z.literal('postgres'),
  url: z.string().min(1),
  ...StorageCommonShape,
})

export const CustomStorageSchema = z.strictObject({
  type: z.literal('custom'),
  module: z.string().min(1).describe('Path to a module implementing the SessionStore interface.'),
  ...StorageCommonShape,
})

/**
 * docs/02-configuration.md §10.
 *
 * `none` is genuinely stateless and therefore genuinely weaker — the client
 * supplies the whole history, so it can forge an assistant turn. That is why
 * cross-field rule 2 forbids it in agent mode (docs/08-security.md §6).
 */
export const StorageSchema = z
  .discriminatedUnion('type', [
    NoneStorageSchema,
    MemoryStorageSchema,
    SqliteStorageSchema,
    RedisStorageSchema,
    PostgresStorageSchema,
    CustomStorageSchema,
  ])
  .describe('docs/02-configuration.md §10.')

export type Storage = z.output<typeof StorageSchema>
