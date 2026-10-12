import { monthlyHistoryCsv } from '@/lib/uptime-history'
import type { StatusPage } from '@/payload-types'
import { pageComponents } from '@/server/status-pages/events'
import { errorResponse } from '@/server/status-pages/http'
import { ownerContext } from '@/server/status-pages/subscribers/owner'
import {
  MAX_HISTORY_MONTHS,
  monthlyUptimeHistory,
  pageUptimeMode,
  type UptimeComponent,
} from '@/server/status-pages/uptime-history'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/status-pages/:id/uptime-history?months=12[&format=csv] — monthly uptime per
 * visible component of the page, newest month first, under the page's calculation mode (#112).
 * Reads the preserved history where retention has pruned the statistics. `format=csv` downloads
 * `month,component_id,component,uptime_percent,downtime_seconds,days` for SLA reports. Needs
 * `status-page:history` (admins by default).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const owner = await ownerContext(request, orgId, id, 'status-page:history')
  if (!owner.ok) return owner.response
  const { payload, page } = owner.ctx
  const url = new URL(request.url)
  const requested = Number(url.searchParams.get('months') ?? 12)
  const months = Number.isFinite(requested)
    ? Math.min(MAX_HISTORY_MONTHS, Math.max(1, Math.floor(requested)))
    : 12

  try {
    const components = await historyComponents(owner.ctx.payload, page)
    const rows = await monthlyUptimeHistory(payload, page, components, { months })

    if (url.searchParams.get('format') === 'csv') {
      return new Response(monthlyHistoryCsv(rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${page.slug}-uptime-history.csv"`,
          'Cache-Control': 'private, no-store',
        },
      })
    }
    return Response.json({
      mode: pageUptimeMode(page),
      months: [...new Set(rows.map((row) => row.month))],
      components: components.map(({ id: componentId, name }) => ({ id: componentId, name })),
      rows,
    })
  } catch (error) {
    return errorResponse(error, request)
  }
}

/** Visible components of the page with their monitors' current status. */
async function historyComponents(
  payload: Parameters<typeof pageComponents>[0],
  page: StatusPage,
): Promise<(UptimeComponent & { name: string })[]> {
  const components = await pageComponents(payload, page)
  const monitorIds = components.flatMap((c) => (c.monitorId ? [c.monitorId] : []))
  const { docs } =
    monitorIds.length === 0
      ? { docs: [] }
      : await payload.find({
          collection: 'monitors',
          where: { id: { in: monitorIds } },
          depth: 0,
          limit: monitorIds.length,
          pagination: false,
          overrideAccess: true,
          select: { status: true },
        })
  // Ids as the adapter stores them (numbers on Postgres), for the statistics queries.
  const monitors = new Map(docs.map((m) => [String(m.id), m]))
  return components.map((component) => {
    const monitor = component.monitorId ? monitors.get(component.monitorId) : undefined
    return {
      id: component.id,
      name: component.name,
      type: component.type,
      monitorId: monitor?.id ?? component.monitorId,
      lastStatus: monitor?.status?.lastStatus ?? null,
    }
  })
}
