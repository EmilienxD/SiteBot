import { randomUUID } from 'node:crypto'
import type { RedisClientType } from 'redis'
import { createStoreRedisClient } from './redis-client.js'
import type { RateLimitResult, RateLimitRule, RateLimitStore } from '../guards/rate-limit.js'

export interface RedisRateLimitStoreOptions {
  url: string
  prefix?: string
  client?: RedisClientType
}

const HIT_SCRIPT = `
local key = KEYS[1]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local window = tonumber(ARGV[1])
local cutoff = now - window
local limit = tonumber(ARGV[2])
local member = tostring(now) .. ':' .. ARGV[3]
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, count, oldest[2] or now, now}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, count + 1, now, now}
`

const USAGE_SCRIPT = `
local key = KEYS[1]
local tokens = redis.call('HINCRBYFLOAT', key, 'tokens', ARGV[1])
local usd = redis.call('HINCRBYFLOAT', key, 'usd', ARGV[2])
redis.call('PEXPIRE', key, ARGV[3])
return {tokens, usd}
`

export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: RedisClientType
  private readonly ownsClient: boolean
  private readonly prefix: string
  private connecting?: Promise<unknown>
  private nonce = 0
  private readonly instanceId = randomUUID()

  constructor(options: RedisRateLimitStoreOptions) {
    this.client = options.client ?? createStoreRedisClient(options.url)
    this.ownsClient = options.client === undefined
    this.prefix = options.prefix ?? 'sitebot:'
  }

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    await this.connect()
    const result = (await this.client.eval(HIT_SCRIPT, {
      keys: [`${this.prefix}rate:${key}`],
      arguments: [String(rule.windowMs), String(rule.limit), `${this.instanceId}:${this.nonce++}`],
    })) as Array<number | string>
    const allowed = Number(result[0]) === 1
    const count = Number(result[1])
    const oldest = Number(result[2])
    const time = Number(result[3])
    return {
      allowed,
      limit: rule.limit,
      remaining: allowed ? Math.max(0, rule.limit - count) : 0,
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((oldest + rule.windowMs - time) / 1000)),
    }
  }

  async getUsage(key: string): Promise<{ tokens: number; usd: number }> {
    await this.connect()
    const values = await this.client.hmGet(`${this.prefix}${key}`, ['tokens', 'usd'])
    return { tokens: Number(values[0] ?? 0), usd: Number(values[1] ?? 0) }
  }

  async addUsage(
    key: string,
    delta: { tokens: number; usd: number },
    ttlMs: number,
  ): Promise<{ tokens: number; usd: number }> {
    await this.connect()
    const values = (await this.client.eval(USAGE_SCRIPT, {
      keys: [`${this.prefix}${key}`],
      arguments: [String(delta.tokens), String(delta.usd), String(ttlMs)],
    })) as Array<number | string>
    return { tokens: Number(values[0]), usd: Number(values[1]) }
  }

  async dispose(): Promise<void> {
    await this.connecting?.catch(() => {})
    if (this.ownsClient && this.client.isOpen) await this.client.quit()
  }

  private async connect(): Promise<void> {
    if (this.connecting !== undefined) {
      await this.connecting
      return
    }
    if (this.client.isOpen) return
    this.connecting = this.client.connect()
    try {
      await this.connecting
    } finally {
      this.connecting = undefined
    }
  }
}

export function createRedisRateLimitStore(options: RedisRateLimitStoreOptions): RateLimitStore {
  return new RedisRateLimitStore(options)
}
