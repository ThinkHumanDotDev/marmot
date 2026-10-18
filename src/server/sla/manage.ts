/**
 * Route and page helpers of the SLA features (#156). Targets and reports are loaded as the
 * request user (`overrideAccess: false`), so a document of another organization is "not found";
 * the figures are then computed by `./compute.ts`.
 */
import type { Payload } from 'payload'

import type { OrgId } from '@/access/permissions'
import {
  periodFromDates,
  previousSchedulePeriod,
  slaReportCsv,
  slaReportFileStem,
  UTC_ZONE,
  type SlaPeriod,
  type SlaReportData,
  type SlaZone,
} from '@/lib/sla'
import type { StatusPageOption } from '@/components/sla/sla-api'
import type { Notification, SlaReport, SlaTarget, StatusPage, User } from '@/payload-types'
import { pageComponents } from '@/server/status-pages/events'
import { parseDocId } from '@/server/notifications/api'
import { relationId } from '@/server/maintenance/serialize'

import { renderSlaReportPdf, type RenderI18n } from './render'

export interface SlaUserContext {
  payload: Payload
  user: User & { collection: 'users' }
  orgId: OrgId
}

/** The organization's targets the user may read, oldest first. */
export async function listOrgTargets(ctx: SlaUserContext): Promise<SlaTarget[]> {
  const { docs } = await ctx.payload.find({
    collection: 'sla-targets',
    where: { organization: { equals: ctx.orgId } },
    sort: 'createdAt',
    depth: 0,
    limit: 500,
    user: ctx.user,
    overrideAccess: false,
  })
  return docs as SlaTarget[]
}

/** The organization's reports the user may read, by name. */
export async function listOrgReports(ctx: SlaUserContext): Promise<SlaReport[]> {
  const { docs } = await ctx.payload.find({
    collection: 'sla-reports',
    where: { organization: { equals: ctx.orgId } },
    sort: 'name',
    depth: 0,
    limit: 500,
    user: ctx.user,
    overrideAccess: false,
  })
  return docs as SlaReport[]
}

/** A report of the organization in the URL, read as the user; null when not found or not allowed. */
export async function loadOrgReport(ctx: SlaUserContext, rawId: string): Promise<SlaReport | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: 'sla-reports',
      id: parseDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as SlaReport
    return String(relationId(doc.organization)) === String(ctx.orgId) ? doc : null
  } catch {
    return null
  }
}

/**
 * The range of `?from=YYYY-MM-DD&to=YYYY-MM-DD` (local days of the organization's time zone); the
 * previous calendar month without them. Null when the parameters are invalid.
 */
export function rangeFromSearchParams(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
  now: Date = new Date(),
  zone: SlaZone = UTC_ZONE,
): SlaPeriod | null {
  const get = (key: string) => {
    const value = params instanceof URLSearchParams ? params.get(key) : params[key]
    return Array.isArray(value) ? value[0] : (value ?? null)
  }
  const from = get('from')
  const to = get('to')
  if (!from && !to) return previousSchedulePeriod('monthly', now, zone)
  if (!from || !to) return null
  return periodFromDates(from, to, zone)
}

export type ReportFormat = 'json' | 'csv' | 'pdf'

export const reportFormatOf = (value: string | null): ReportFormat | null =>
  value === null || value === '' || value === 'json'
    ? 'json'
    : value === 'csv' || value === 'pdf'
      ? value
      : null

/** A built report as a response in `format`. */
export function reportResponse(
  data: SlaReportData,
  format: ReportFormat,
  i18n: RenderI18n,
  cache: string,
): Response {
  const stem = slaReportFileStem(data)
  if (format === 'csv') {
    return new Response(slaReportCsv(data), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${stem}.csv"`,
        'Cache-Control': cache,
      },
    })
  }
  if (format === 'pdf') {
    return new Response(new Uint8Array(renderSlaReportPdf(data, i18n)), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${stem}.pdf"`,
        'Cache-Control': cache,
      },
    })
  }
  return Response.json(data, { headers: { 'Cache-Control': cache } })
}

/**
 * Status pages of the organization the user may read, with their groups and visible components,
 * for component and group targets (#274).
 */
export async function statusPageOptions(ctx: SlaUserContext): Promise<StatusPageOption[]> {
  const { docs } = await ctx.payload.find({
    collection: 'status-pages',
    where: { organization: { equals: ctx.orgId } },
    sort: 'title',
    depth: 0,
    limit: 200,
    pagination: false,
    user: ctx.user,
    overrideAccess: false,
  })
  return Promise.all(
    (docs as StatusPage[]).map(async (page) => {
      const names = new Map((await pageComponents(ctx.payload, page)).map((c) => [c.id, c.name]))
      return {
        id: String(page.id),
        title: page.title,
        groups: (page.groups ?? []).flatMap((group) =>
          group.id
            ? [
                {
                  id: group.id,
                  name: group.name,
                  components: (group.monitors ?? []).flatMap((row) =>
                    row.id && names.has(row.id) ? [{ id: row.id, name: names.get(row.id)! }] : [],
                  ),
                },
              ]
            : [],
        ),
      }
    }),
  )
}

/** Notification channels of the organization the user may read, for error budget alerts. */
export async function channelOptions(ctx: SlaUserContext): Promise<{ id: string; name: string }[]> {
  const { docs } = await ctx.payload
    .find({
      collection: 'notifications',
      where: { organization: { equals: ctx.orgId } },
      sort: 'name',
      depth: 0,
      limit: 500,
      pagination: false,
      user: ctx.user,
      overrideAccess: false,
      select: { name: true },
    })
    .catch(() => ({ docs: [] as Pick<Notification, 'id' | 'name'>[] }))
  return docs.map((doc) => ({ id: String(doc.id), name: doc.name }))
}
