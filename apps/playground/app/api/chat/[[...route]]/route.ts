import { getHandler } from '@/lib/sitebot'

/**
 * The whole server-side integration: one catch-all route file.
 *
 * The optional catch-all segment (`[[...route]]`) is what makes all four
 * endpoints reachable from one file — `/api/chat`, plus `/config`, `/feedback`
 * and `/health` underneath it. A plain `route.ts` at `app/api/chat/` would serve
 * only the first.
 *
 * `runtime: nodejs` because the config loader reads the YAML file from disk.
 * A deployment that passes a config object instead can run this on the edge.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const dispatch = async (request: Request): Promise<Response> => (await getHandler())(request)

export const GET = dispatch
export const POST = dispatch
export const OPTIONS = dispatch
