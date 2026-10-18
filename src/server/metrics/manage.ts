/**
 * Metric management behind `/api/orgs/:orgId/metrics/**` and Settings → Metrics (#155). The
 * routes authorise; these functions read and write as the user (`overrideAccess: false`), so a
 * metric of another organization is "not found".
 */
import type { Payload } from 'payload'

import type { OrgId } from '@/access/permissions'
import { relId } from '@/collections/shared'
import { DEFAULT_METRIC_VIEW, type MetricRow } from '@/lib/metrics'
import type { Metric, StatusPage, User } from '@/payload-types'
import { apiError } from '@/server/errors'

import { orderForPage } from './public'
import type { MetricCreateInput, MetricUpdateInput } from './schemas'

export interface MetricContext {
  payload: Payload
  user: User & { collection: 'users' }
  orgId: OrgId
}

const toDocId = (payload: Payload, raw: string): string | number =>
  payload.db.defaultIDType === 'number' && /^\d+$/.test(raw) ? Number(raw) : raw

const idString = (value: unknown): string | null => {
  const id = relId(value)
  return id === null ? null : String(id)
}

export function toMetricRow(doc: Metric): MetricRow {
  return {
    id: String(doc.id),
    name: doc.name,
    description: doc.description ?? null,
    suffix: doc.suffix ?? null,
    decimals: doc.decimals ?? 0,
    aggregation: doc.aggregation ?? 'average',
    defaultView: doc.defaultView ?? DEFAULT_METRIC_VIEW,
    thresholds: {
      warning: doc.thresholds?.warning ?? null,
      critical: doc.thresholds?.critical ?? null,
    },
    showThresholdState: doc.showThresholdState === true,
    source: doc.source ?? 'push',
    monitor: idString(doc.monitor),
    visible: doc.visible === true,
    order: doc.order ?? 0,
    statusPages: (doc.statusPages ?? []).map(idString).filter((id): id is string => id !== null),
    lastValue: doc.lastValue ?? null,
    lastPushAt: doc.lastPushAt ?? null,
    createdAt: doc.createdAt,
  }
}

/** The metric when the user may read it and it belongs to the organization in the URL. */
export async function loadOrgMetric(ctx: MetricContext, rawId: string): Promise<Metric | null> {
  try {
    const doc = await ctx.payload.findByID({
      collection: 'metrics',
      id: toDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })
    return String(relId(doc.organization)) === String(ctx.orgId) ? doc : null
  } catch {
    return null
  }
}

export async function listMetrics(ctx: MetricContext): Promise<MetricRow[]> {
  const { docs } = await ctx.payload.find({
    collection: 'metrics',
    where: { organization: { equals: ctx.orgId } },
    sort: ['order', 'name'],
    depth: 0,
    limit: 500,
    user: ctx.user,
    overrideAccess: false,
  })
  return docs.map(toMetricRow)
}

const relationIds = (payload: Payload, ids: Array<string | number> | undefined) =>
  ids?.map((id) => (typeof id === 'string' ? toDocId(payload, id) : id))

function toData(payload: Payload, input: MetricUpdateInput) {
  const { monitor, statusPages, ...rest } = input
  return {
    ...rest,
    ...(monitor !== undefined
      ? { monitor: typeof monitor === 'string' ? toDocId(payload, monitor) : monitor }
      : {}),
    ...(statusPages !== undefined ? { statusPages: relationIds(payload, statusPages) } : {}),
  }
}

export async function createMetric(
  ctx: MetricContext,
  input: MetricCreateInput,
): Promise<MetricRow> {
  const doc = await ctx.payload.create({
    collection: 'metrics',
    data: { ...toData(ctx.payload, input), organization: ctx.orgId } as never,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
  return toMetricRow(doc)
}

export async function updateMetric(
  ctx: MetricContext,
  metric: Metric,
  input: MetricUpdateInput,
): Promise<MetricRow> {
  const doc = await ctx.payload.update({
    collection: 'metrics',
    id: metric.id,
    data: toData(ctx.payload, input) as never,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
  return toMetricRow(doc)
}

export async function deleteMetric(ctx: MetricContext, metric: Metric): Promise<void> {
  await ctx.payload.delete({
    collection: 'metrics',
    id: metric.id,
    user: ctx.user,
    overrideAccess: false,
  })
}

// ---- Status page builder (#280) --------------------------------------------------------------

/** The metrics a page shows (`statusPages` holds it), in the page's display order. */
export interface PageMetrics {
  /** Every metric of the organization the user may read, in their own order. */
  metrics: MetricRow[]
  /** Ids of the metrics listing the page, in its display order. */
  selected: string[]
}

type PageRef = Pick<StatusPage, 'id' | 'metricOrder'>

function selectedOf(rows: MetricRow[], page: PageRef): string[] {
  const listed = rows.filter((row) => row.statusPages.includes(String(page.id)))
  return orderForPage(listed, page.metricOrder).map((row) => row.id)
}

export async function listPageMetrics(ctx: MetricContext, page: PageRef): Promise<PageMetrics> {
  const metrics = await listMetrics(ctx)
  return { metrics, selected: selectedOf(metrics, page) }
}

/**
 * Pick and order the page's metrics: `ids` (metrics of the organization, in display order) list the
 * page, every other metric stops listing it, and the page keeps the order in `metricOrder`. Writes
 * as the user, so `metric:update` and `status-page:update` both apply. Whether a metric is
 * published (`visible`) is left alone.
 */
export async function setPageMetrics(
  ctx: MetricContext,
  page: PageRef,
  ids: readonly string[],
): Promise<PageMetrics> {
  const wanted = [...new Set(ids.map(String))]
  const rows = await listMetrics(ctx)
  const byId = new Map(rows.map((row) => [row.id, row]))
  if (wanted.some((id) => !byId.has(id))) throw apiError('pageMetricsInvalid', 400)

  const pageId = String(page.id)
  for (const row of rows) {
    const listed = row.statusPages.includes(pageId)
    const want = wanted.includes(row.id)
    if (listed === want) continue
    const statusPages = want
      ? [...row.statusPages, pageId]
      : row.statusPages.filter((id) => id !== pageId)
    await ctx.payload.update({
      collection: 'metrics',
      id: toDocId(ctx.payload, row.id),
      data: { statusPages: relationIds(ctx.payload, statusPages) } as never,
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })
  }
  const updated = await ctx.payload.update({
    collection: 'status-pages',
    id: page.id,
    data: { metricOrder: relationIds(ctx.payload, wanted) } as never,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
  return listPageMetrics(ctx, updated)
}
