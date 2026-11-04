import { getPayload } from 'payload'

import config from '@payload-config'
import { handleHostMetricsRequest } from '@/server/host-metrics/http'

export const dynamic = 'force-dynamic'

/**
 * POST /api/agent/v1/metrics — one sample from a host agent (#136), authenticated with the host
 * monitor's token (`Authorization: Bearer <token>`). See `src/server/host-metrics/http.ts`.
 */
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  return handleHostMetricsRequest(payload, request)
}
