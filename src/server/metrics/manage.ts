/**
 * Metric management behind `/api/orgs/:orgId/metrics/**` and Settings → Metrics (#155). The
 * routes authorise; these functions read and write as the user (`overrideAccess: false`), so a
 * metric of another organization is "not found".
 */
import type { Payload } from 'payload'

import type { OrgId } from '@/access/permissions'
import { relId } from '@/collections/shared'
import { DEFAULT_METRIC_VIEW, type MetricRow } from '@/lib/metrics'
import type { Metric, User } from '@/payload-types'

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
