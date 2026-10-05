import { getPayload } from 'payload'

import config from '@payload-config'
import { handleImportRequest } from '@/server/import-export/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * POST /api/orgs/:orgId/import/uptime-kuma[?dryRun=1] — import an Uptime Kuma backup JSON
 * (`Uptime_Kuma_Backup_*.json`). Same permissions and response as `/import`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId } = await params
  return handleImportRequest(payload, request, orgId, 'uptime-kuma')
}
