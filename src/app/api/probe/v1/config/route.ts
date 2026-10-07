import { getPayload } from 'payload'

import config from '@payload-config'
import { authenticateProbe, buildProbeConfig, etagMatches } from '@/server/probes'

export const dynamic = 'force-dynamic'

/**
 * GET /api/probe/v1/config — the monitors assigned to the calling probe's location (#91),
 * authenticated by the location token (`Authorization: Bearer mp_…`). Answers `304` when
 * `If-None-Match` names the current ETag. Every call counts as a sign of life of the location.
 */
export async function GET(request: Request) {
  const payload = await getPayload({ config })
  const auth = await authenticateProbe(payload, request)
  if ('response' in auth) return auth.response

  const { config: body, etag } = await buildProbeConfig(payload, auth.location)
  const headers = { ETag: etag, 'Cache-Control': 'no-store' }
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers })
  }
  return Response.json(body, { headers })
}
