import { env } from '@/env'
import { buildManagementOpenApi } from '@/server/api/openapi'

export const dynamic = 'force-dynamic'

let cached: string | undefined

/**
 * GET /api/openapi.json — OpenAPI 3.1 description of the management API (`/api/orgs/:orgId/**`),
 * public so clients and generators can fetch it without credentials. On a status page's custom
 * domain the same path is rewritten to that page's public API document (`src/proxy.ts`).
 */
export function GET() {
  cached ??= JSON.stringify(buildManagementOpenApi(env.NEXT_PUBLIC_SERVER_URL), null, 2)
  return new Response(cached, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
