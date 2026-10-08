import { getPayload } from 'payload'

import config from '@payload-config'
import { authenticateApiKey } from '@/server/api-keys'
import { collectOrganizationMetrics } from '@/server/metrics/prometheus'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/metrics` — Prometheus exposition for the organization of the API key carried by the
 * request (`Authorization: Bearer mk_…`, `X-API-Key`, or basic auth with the key as password).
 * 401 without a valid key; the registry is built per scrape from the database.
 * `?quantiles=true` adds `monitor_response_time_quantile` (p50 … p99 over 24h and 30d, #95).
 */
export async function GET(request: Request) {
  const payload = await getPayload({ config })
  const auth = await authenticateApiKey(payload, request)
  if (!auth) {
    return Response.json(
      { error: errorText(request, 'unauthenticated') },
      {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Bearer realm="marmot-metrics", Basic realm="marmot-metrics"',
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  const quantiles = ['1', 'true', 'yes'].includes(
    (new URL(request.url).searchParams.get('quantiles') ?? '').toLowerCase(),
  )
  const registry = await collectOrganizationMetrics(payload, auth.organizationId, { quantiles })
  return new Response(await registry.metrics(), {
    status: 200,
    headers: { 'Content-Type': registry.contentType, 'Cache-Control': 'no-store' },
  })
}
