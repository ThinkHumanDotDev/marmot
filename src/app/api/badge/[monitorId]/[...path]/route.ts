import { getPayload } from 'payload'

import config from '@payload-config'
import { serveBadge } from '@/server/badges'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ monitorId: string; path: string[] }> }

/**
 * `GET /api/badge/:monitorId/status`, `…/uptime/:duration?`, `…/ping/:duration?`,
 * `…/avg-response/:duration?`, `…/cert-exp`, `…/response` → shields.io-style SVG.
 * See `docs/integrations.md` for the query parameters.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { monitorId, path } = await params
  const payload = await getPayload({ config })
  return serveBadge(payload, request, monitorId, path ?? [])
}
