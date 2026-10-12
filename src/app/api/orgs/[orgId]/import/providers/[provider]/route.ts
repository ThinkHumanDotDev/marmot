import { getPayload } from 'payload'

import config from '@payload-config'
import { handleProviderImportRequest } from '@/server/import-export/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; provider: string }> }

/**
 * POST /api/orgs/:orgId/import/providers/:provider[?dryRun=1] — import from a hosted service's API
 * (`statuspage`, `betterstack`; #120). Body: `{ credentials, resources }`. The credentials are
 * used for this request only and never stored. Same permissions and report as `/import`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId, provider } = await params
  return handleProviderImportRequest(payload, request, orgId, provider)
}
