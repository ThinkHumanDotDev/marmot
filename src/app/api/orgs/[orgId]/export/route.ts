import { getPayload } from 'payload'

import config from '@payload-config'
import { buildMarmotExport } from '@/server/import-export/marmot'
import { authenticate, authorize, parseId, payloadError } from '@/server/monitors/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/export — download the organization's monitors, notification channels
 * (configs as stored, secrets included) and status pages as a Marmot export JSON file.
 * Requires `organization:update`.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = authorize(auth.user, orgId, 'organization:update')
  if (forbidden) return forbidden

  try {
    const data = await buildMarmotExport(payload, { orgId, user: auth.user })
    const date = data.exportedAt.slice(0, 10)
    const filename = `marmot-export-${data.organization.slug}-${date}.json`
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return payloadError(error)
  }
}
