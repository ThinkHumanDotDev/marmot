import { getPayload } from 'payload'

import config from '@payload-config'
import { authenticateApiKey } from '@/server/api-keys'
import { collectOrganizationMetrics } from '@/server/metrics/prometheus'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/metrics` — Prometheus exposition for the organization of the API key carried by the
 * request (`Authorization: Bearer mk_…`, `X-API-Key`, or basic auth with the key as password).
 * 401 without a valid key; the registry is built per scrape from the database.
 */
export async function GET(request: Request) {
  const payload = await getPayload({ config })
  const auth = await authenticateApiKey(payload, request)
  if (!auth) {
    return Response.json(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Bearer realm="marmot-metrics", Basic realm="marmot-metrics"',
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  const registry = await collectOrganizationMetrics(payload, auth.organizationId)
  return new Response(await registry.metrics(), {
    status: 200,
    headers: { 'Content-Type': registry.contentType, 'Cache-Control': 'no-store' },
  })
}
