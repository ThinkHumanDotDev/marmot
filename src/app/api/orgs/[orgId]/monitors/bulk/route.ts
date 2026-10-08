import { getPayload } from 'payload'

import config from '@payload-config'
import { bulkActionPermission } from '@/lib/monitor-bulk'
import { runMonitorBulkAction } from '@/server/monitors/bulk'
import { monitorBulkBody } from '@/server/monitors/bulk-schema'
import {
  authenticate,
  authorize,
  jsonError,
  parseId,
  readJson,
  validationError,
} from '@/server/monitors/http'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * POST /api/orgs/:orgId/monitors/bulk — one action on many monitors (#124):
 * `{ ids, action, payload }` with `action` one of `pause`, `resume`, `check`, `delete`,
 * `addTags` / `removeTags` (`payload.tags: [{ tag, value? }]`) and `addNotifications` /
 * `removeNotifications` (`payload.notifications: [id]`).
 *
 * Needs `monitor:delete` for `delete` and `monitor:update` otherwise. Answers `200` with one
 * result per id (`{ id, ok, unchanged?, monitor? }` or `{ id, ok: false, error, message }`) and a
 * summary; see `src/server/monitors/bulk.ts` for the rules.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId } = await params
  const orgId = parseId(payload, rawOrgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response

  const body = await readJson(request)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, errorText(request, 'expectedJsonBody'))
  }
  const parsed = monitorBulkBody.safeParse(body)
  if (!parsed.success) return validationError(parsed.error, request)

  const forbidden = await authorize(
    payload,
    auth.user,
    orgId,
    bulkActionPermission(parsed.data.action),
  )
  if (forbidden) return forbidden

  const result = await runMonitorBulkAction(
    { payload, request, user: auth.user, orgId },
    parsed.data,
  )
  return result instanceof Response ? result : Response.json(result)
}
