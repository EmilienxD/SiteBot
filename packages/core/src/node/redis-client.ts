import { createClient, type RedisClientType } from 'redis'

/** Fail the request on an outage; a later request can reopen the connection. */
export function createStoreRedisClient(url: string): RedisClientType {
  const client = createClient({
    url,
    socket: { connectTimeout: 5000, reconnectStrategy: false },
    disableOfflineQueue: true,
  })
  // node-redis requires an error listener even when command/connect promises
  // are handled. Never log the raw client error: it may include connection data.
  client.on('error', () => {})
  return client
}
