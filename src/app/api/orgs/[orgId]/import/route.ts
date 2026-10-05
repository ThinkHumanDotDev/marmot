import { getPayload } from 'payload'

import config from '@payload-config'
import { handleImportRequest } from '@/server/import-export/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * POST /api/orgs/:orgId/import[?dryRun=1] — import a Marmot export or an Uptime Kuma backup
 * (format auto-detected). Body: the file's JSON. Requires `monitor:create`; notification channels
 * and status pages need `notification:create` / `status-page:create` and are skipped otherwise.
 * Returns an `ImportReport` (200 on dry run, 201 after a committed import).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId } = await params
  return handleImportRequest(payload, request, orgId)
}
