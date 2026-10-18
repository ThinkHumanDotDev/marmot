/**
 * Metrics a status page publishes (#155): `visible` metrics of the page's organization that list
 * the page in `statusPages`. Visitors get display settings and aggregates only, never the source
 * monitor, the push time or the organization.
 */
import type { Payload } from 'payload'

import { relId } from '@/collections/shared'
import {
  DEFAULT_METRIC_VIEW,
  metricThresholdState,
  type MetricView,
  type PublicMetric,
} from '@/lib/metrics'
import type { Metric, StatusPage } from '@/payload-types'
import { isMetricVisibleOn } from '@/server/status-pages/audiences'

import { readMetricSeries } from './series'

/** The page fields the published metrics depend on. */
export type MetricsPage = Pick<StatusPage, 'id' | 'organization' | 'access' | 'groups'> &
  Partial<Pick<StatusPage, 'metricOrder'>>

/**
 * Metrics in the page's display order (#280): those in `metricOrder` first, in that order, then the
 * rest in their own order (`docs` arrive sorted by `order`, `name`). Pure; exported for tests.
 */
export function orderForPage<T extends { id: string | number }>(
  docs: readonly T[],
  metricOrder: StatusPage['metricOrder'],
): T[] {
  const rank = new Map<string, number>()
  for (const entry of metricOrder ?? []) {
    const id = relId(entry)
    if (id !== null && !rank.has(String(id))) rank.set(String(id), rank.size)
  }
  if (rank.size === 0) return [...docs]
  return docs
    .map((doc, index) => ({ doc, index, rank: rank.get(String(doc.id)) ?? rank.size + index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ doc }) => doc)
}

/**
 * The page's published metrics in display order (`metricId`: just that one). Pass the page scoped
 * to the visitor (`scopePageForVisitor`): on `audience` pages (#151) a monitor-backed metric is
 * only listed when its monitor is one of the visitor's components.
 */
export async function findPublishedMetrics(
  payload: Payload,
  page: MetricsPage,
  metricId?: string,
): Promise<Metric[]> {
  const organization = relId(page.organization)
  if (organization === null) return []
  const { docs } = await payload.find({
    collection: 'metrics',
    where: {
      and: [
        { organization: { equals: organization } },
        { visible: { equals: true } },
        { statusPages: { in: [page.id] } },
      ],
    },
    sort: ['order', 'name'],
    depth: 0,
    limit: 50,
    pagination: false,
    overrideAccess: true,
  })
  const visible = orderForPage(
    docs.filter((doc) => isMetricVisibleOn(page, doc)),
    page.metricOrder,
  )
  return metricId === undefined ? visible : visible.filter((doc) => String(doc.id) === metricId)
}

export async function toPublicMetric(
  payload: Payload,
  metric: Metric,
  view: MetricView | undefined,
  now: Date = new Date(),
): Promise<PublicMetric> {
  const defaultView = metric.defaultView ?? DEFAULT_METRIC_VIEW
  const series = await readMetricSeries(payload, metric, view ?? defaultView, now)
  const description = metric.description?.trim()
  const thresholds = {
    warning: metric.thresholds?.warning ?? null,
    critical: metric.thresholds?.critical ?? null,
  }
  return {
    id: String(metric.id),
    name: metric.name,
    ...(description ? { description } : {}),
    suffix: metric.suffix?.trim() || null,
    decimals: metric.decimals ?? 0,
    aggregation: metric.aggregation ?? 'average',
    defaultView,
    view: series.view,
    thresholds,
    showThresholdState: metric.showThresholdState === true,
    state: metricThresholdState(series.current, thresholds),
    step: series.step,
    current: series.current,
    summary: series.summary,
    series: series.series,
  }
}

/**
 * Published metrics of the page with their series: each in its default view, or in `view` when
 * given (a visitor switching the period of one metric passes `metricId`).
 */
export async function buildPublicMetrics(
  payload: Payload,
  page: MetricsPage,
  options: { metricId?: string; view?: MetricView; now?: Date } = {},
): Promise<PublicMetric[]> {
  const metrics = await findPublishedMetrics(payload, page, options.metricId)
  const now = options.now ?? new Date()
  return Promise.all(metrics.map((metric) => toPublicMetric(payload, metric, options.view, now)))
}
