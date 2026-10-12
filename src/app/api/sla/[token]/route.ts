import { getPayload } from 'payload'

import config from '@payload-config'
import { jsonError } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { getOrganizationI18n } from '@/server/i18n'
import { relationId } from '@/server/maintenance/serialize'
import { buildSlaReport } from '@/server/sla/compute'
import { reportFormatOf, reportResponse } from '@/server/sla/manage'
import { resolveShare } from '@/server/sla/shares'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ token: string }> }

/**
 * GET /api/sla/:token[?format=csv|pdf] — the shared SLA report behind a public link (#156): that
 * report over the link's range and nothing else. Unknown and revoked tokens get the same 404.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { token } = await params
  const format = reportFormatOf(new URL(request.url).searchParams.get('format'))
  if (!format) return jsonError(400, errorText(request, 'slaRangeInvalid'))
  const payload = await getPayload({ config })
  const shared = await resolveShare(payload, token)
  if (!shared) return jsonError(404, errorText(request, 'slaShareNotFound'))
  const data = await buildSlaReport(payload, shared.report, shared.period)
  const i18n = await getOrganizationI18n(payload, relationId(shared.report.organization))
  const response = reportResponse(data, format, i18n, 'private, no-store')
  response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}
