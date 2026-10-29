import { describe, expect, it, vi } from 'vitest'
import { createRedisRateLimitStore } from './redis-rate-limit.js'

describe('Redis counter connection lifecycle (injected client, no network)', () => {
  it('retries after a failed connect and never closes a caller-owned connection', async () => {
    const client = {
      isOpen: false,
      connect: vi.fn(),
      hmGet: vi.fn(async () => ['42', '0.01']),
      quit: vi.fn(async () => {}),
    }
    client.connect
      .mockRejectedValueOnce(new Error('synthetic outage'))
      .mockImplementation(async () => {
        client.isOpen = true
      })
    const store = createRedisRateLimitStore({ url: 'redis://unused', client: client as never })
    await expect(store.getUsage!('synthetic')).rejects.toThrow('synthetic outage')
    expect(client.hmGet).not.toHaveBeenCalled()
    expect(await store.getUsage!('synthetic')).toEqual({ tokens: 42, usd: 0.01 })
    await store.dispose?.()
    expect(client.quit).not.toHaveBeenCalled()
  })

  it('awaits the shared connection promise even when isOpen becomes true before ready', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = {
      isOpen: false,
      connect: vi.fn(() => {
        client.isOpen = true
        return pending
      }),
      hmGet: vi.fn(async () => ['0', '0']),
    }
    const store = createRedisRateLimitStore({ url: 'redis://unused', client: client as never })
    const first = store.getUsage!('one')
    const second = store.getUsage!('two')
    expect(client.hmGet).not.toHaveBeenCalled()
    release()
    await Promise.all([first, second])
    expect(client.connect).toHaveBeenCalledTimes(1)
    expect(client.hmGet).toHaveBeenCalledTimes(2)
  })
})
