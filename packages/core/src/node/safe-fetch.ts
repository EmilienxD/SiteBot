import { Agent, fetch as undiciFetch } from 'undici'
import type { HostResolver } from '../tools/http.js'

export interface SafeFetch {
  fetch: typeof fetch
  resolveHost: HostResolver
}

export function createSafeFetch(): SafeFetch {
  const cache = new Map<string, string[]>()
  const resolveHost: HostResolver = async (hostname) => {
    const cached = cache.get(hostname)
    if (cached !== undefined) return cached
    const { lookup } = await import('node:dns/promises')
    const addresses = (await lookup(hostname, { all: true, verbatim: true })).map(
      (entry) => entry.address,
    )
    cache.set(hostname, addresses)
    return addresses
  }
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        void resolveHost(hostname)
          .then((addresses) => {
            // Happy-eyeballs (`autoSelectFamily`, on by default since Node 20)
            // asks for every address; answering with one string makes net
            // read `undefined` and fail every request "Invalid IP address".
            if ((options as { all?: boolean }).all === true) {
              if (addresses.length === 0) throw new Error(`No address found for ${hostname}.`)
              const all: { address: string; family: number }[] = addresses.map((address) => ({
                address,
                family: address.includes(':') ? 6 : 4,
              }))
              ;(
                callback as unknown as (
                  error: null,
                  all: { address: string; family: number }[],
                ) => void
              )(null, all)
              return
            }
            const family = options.family === 6 ? 6 : 4
            const address =
              addresses.find((candidate) =>
                family === 6 ? candidate.includes(':') : !candidate.includes(':'),
              ) ?? addresses[0]
            if (address === undefined) throw new Error(`No address found for ${hostname}.`)
            callback(null, address, address.includes(':') ? 6 : 4)
          })
          .catch((error: unknown) => callback(error as Error, '', 4))
      },
    },
  })
  const fetchImpl: typeof fetch = (input, init) =>
    undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...init,
        dispatcher,
      } as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>
  return { fetch: fetchImpl, resolveHost }
}
