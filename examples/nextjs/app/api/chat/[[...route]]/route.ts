import { handlers } from '@/lib/sitebot'

// The optional catch-all makes /api/chat and its /config, /feedback and
// /health sub-routes reachable from this one file.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = async (request: Request) => (await handlers()).GET(request)
export const POST = async (request: Request) => (await handlers()).POST(request)
export const OPTIONS = async (request: Request) => (await handlers()).OPTIONS(request)
