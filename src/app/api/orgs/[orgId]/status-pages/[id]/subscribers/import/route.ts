import { demoRefusal } from '@/server/demo/config'
import { isSubscriberChannel } from '@/lib/status-page-subscribers'
import { relationId } from '@/server/audit/collection-hooks'
import { actorFromRequest, AUDIT_SKIP_CONTEXT } from '@/server/audit/context'
import { actorFields, recordRequestAuditEvent } from '@/server/security/audit'
import { errorResponse, jsonError } from '@/server/status-pages/http'
import { errorMessageFor, errorText } from '@/server/request-locale'
import {
  MAX_IMPORT_ROWS,
  csvSubscriberRows,
  ownerContext,
} from '@/server/status-pages/subscribers/owner'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

async function readCsv(request: Request): Promise<string | null> {
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    return file && typeof file !== 'string' ? file.text() : null
  }
  return request.text().catch(() => null)
}

/**
 * POST /api/orgs/:orgId/status-pages/:id/subscribers/import — CSV (`text/csv` body or multipart
 * `file`) with `channel`, `target` and optionally `components` (`;`-separated component ids).
 * Imported subscribers are confirmed at once (`source: import`); existing and invalid rows are
 * skipped and reported. Needs `subscriber:manage`. At most 10 000 rows.
 */
export async function POST(request: Request, { params }: RouteContext) {
  // Demo mode (#159): no bulk lists of (real) addresses on a public demo.
  const refused = demoRefusal(request, 'imports')
  if (refused) return refused
  const { orgId, id } = await params
  const owner = await ownerContext(request, orgId, id, 'subscriber:manage')
  if (!owner.ok) return owner.response
  const { payload, user, page } = owner.ctx
  const text = await readCsv(request)
  const rows = text ? csvSubscriberRows(text) : null
  if (!rows || rows.length > MAX_IMPORT_ROWS) {
    return jsonError(errorText(request, 'subscriberImportInvalid'), 400)
  }

  let created = 0
  const skipped: { line: number; reason: string }[] = []
  try {
    for (const row of rows) {
      if (!isSubscriberChannel(row.channel)) {
        skipped.push({ line: row.line, reason: errorText(request, 'subscriberTargetInvalid') })
        continue
      }
      try {
        await payload.create({
          collection: 'status-page-subscribers',
          data: {
            organization: page.organization,
            statusPage: page.id,
            channel: row.channel,
            target: row.target,
            components: row.components,
            source: 'import',
          },
          depth: 0,
          user,
          overrideAccess: false,
          // Summarised by one `import.completed` row below instead of a row per subscriber.
          context: { [AUDIT_SKIP_CONTEXT]: true },
        })
        created += 1
      } catch (error) {
        const data = (error as { data?: { errors?: { message?: string }[] } }).data
        skipped.push({
          line: row.line,
          reason: data?.errors?.[0]?.message ?? errorMessageFor(request, error, 'unexpected'),
        })
      }
    }
    await recordRequestAuditEvent(payload, request, {
      ...actorFields(actorFromRequest({ user })),
      action: 'import.completed',
      organization: relationId(page.organization),
      entityType: 'import',
      entityLabel: 'subscribers',
      metadata: {
        format: 'subscribers-csv',
        statusPageId: String(page.id),
        subscribers: created,
        skipped: skipped.length,
      },
    })
    return Response.json({ created, skipped })
  } catch (error) {
    return errorResponse(error, request)
  }
}
