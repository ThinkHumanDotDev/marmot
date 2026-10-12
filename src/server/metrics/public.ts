/**
 * Metrics a status page publishes (#155): `visible` metrics of the page's organization that list
 * the page in `statusPages`. Visitors get display settings and aggregates only, never the source
 * monitor, the push time or the organization.
 */
import type { Payload } from 'payload'

import { relId } from '@/collections/shared'
import { DEFAULT_METRIC_VIEW, type MetricView, type PublicMetric } from '@/lib/metrics'
import type { Metric, StatusPage } from '@/payload-types'

import { readMetricSeries } from './series'

/** The page's published metrics in display order (`metricId`: just that one). */
export async function findPublishedMetrics(
  payload: Payload,
  page: Pick<StatusPage, 'id' | 'organization'>,
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
  return metricId === undefined ? docs : docs.filter((doc) => String(doc.id) === metricId)
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
  return {
    id: String(metric.id),
    name: metric.name,
    ...(description ? { description } : {}),
    suffix: metric.suffix?.trim() || null,
    decimals: metric.decimals ?? 0,
    aggregation: metric.aggregation ?? 'average',
    defaultView,
    view: series.view,
    thresholds: {
      warning: metric.thresholds?.warning ?? null,
      critical: metric.thresholds?.critical ?? null,
    },
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
  page: Pick<StatusPage, 'id' | 'organization'>,
  options: { metricId?: string; view?: MetricView; now?: Date } = {},
): Promise<PublicMetric[]> {
  const metrics = await findPublishedMetrics(payload, page, options.metricId)
  const now = options.now ?? new Date()
  return Promise.all(metrics.map((metric) => toPublicMetric(payload, metric, options.view, now)))
}
