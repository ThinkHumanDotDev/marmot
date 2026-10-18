import { isSlaSchedule, periodDates, periodFromDates, previousSchedulePeriod } from '@/lib/sla'
import { errorMessage, jsonError, readJson, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { loadOrgReport } from '@/server/sla/manage'
import { sendSlaReport } from '@/server/sla/schedule'
import { loadSlaZone } from '@/server/sla/zone'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * POST /api/orgs/:orgId/sla/reports/:id/send `{ test?, from?, to? }` — email the report now (#274),
 * with the CSV and PDF attached, over `from`..`to` (inclusive `YYYY-MM-DD` days of the
 * organization's time zone; default: the schedule's last complete period, or the previous month).
 * `test: true` sends it to the caller only; otherwise to the report's recipients, recording
 * `lastSentAt`. The schedule's bookkeeping (`lastSentPeriod`) is left alone, so the scheduled
 * email still goes out. Needs `sla:manage`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sla:manage')
  if (ctx instanceof Response) return ctx
  const body = (await readJson<{ test?: unknown; from?: unknown; to?: unknown }>(request)) ?? {}

  const report = await loadOrgReport(ctx, id)
  if (!report) return jsonError(404, errorText(request, 'slaReportNotFound'))

  const now = new Date()
  const zone = await loadSlaZone(ctx.payload, ctx.orgId)
  const period =
    body.from === undefined && body.to === undefined
      ? previousSchedulePeriod(
          isSlaSchedule(report.schedule) && report.schedule !== 'none'
            ? report.schedule
            : 'monthly',
          now,
          zone,
        )
      : typeof body.from === 'string' && typeof body.to === 'string'
        ? periodFromDates(body.from, body.to, zone)
        : null
  if (!period) return jsonError(400, errorText(request, 'slaRangeInvalid'))

  const test = body.test === true
  const recipients = test
    ? [ctx.user.email].filter(Boolean)
    : (report.recipients ?? []).map((row) => row.email).filter(Boolean)
  if (recipients.length === 0) {
    return jsonError(400, errorText(request, test ? 'slaNoEmail' : 'slaNoRecipients'))
  }

  try {
    await sendSlaReport(ctx.payload, report, period, recipients, now)
    if (!test) {
      await ctx.payload.update({
        collection: 'sla-reports',
        id: report.id,
        data: { lastSentAt: now.toISOString() },
        depth: 0,
        overrideAccess: true,
      })
    }
    return Response.json({ sent: recipients.length, test, ...periodDates(period, zone) })
  } catch (error) {
    return jsonError(502, errorMessage(error, request))
  }
}
