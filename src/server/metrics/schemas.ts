/**
 * Request bodies of the metric routes (#155), also used by the OpenAPI document so it cannot drift
 * from validation.
 */
import { z } from 'zod'

import {
  METRIC_AGGREGATIONS,
  METRIC_DESCRIPTION_MAX_LENGTH,
  METRIC_MAX_ABS_VALUE,
  METRIC_MAX_DECIMALS,
  METRIC_MAX_POINTS_PER_PUSH,
  METRIC_NAME_MAX_LENGTH,
  METRIC_SOURCES,
  METRIC_SUFFIX_MAX_LENGTH,
  METRIC_VIEWS,
} from '@/lib/metrics'

const id = z.union([z.string().min(1), z.number().int()])
const threshold = z.number().finite().nullable().optional()

export const metricCreateSchema = z.object({
  name: z.string().trim().min(1).max(METRIC_NAME_MAX_LENGTH),
  description: z.string().trim().max(METRIC_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  suffix: z.string().trim().max(METRIC_SUFFIX_MAX_LENGTH).nullable().optional(),
  decimals: z.number().int().min(0).max(METRIC_MAX_DECIMALS).optional(),
  aggregation: z.enum(METRIC_AGGREGATIONS).optional(),
  defaultView: z.enum(METRIC_VIEWS).optional(),
  thresholds: z.object({ warning: threshold, critical: threshold }).optional(),
  showThresholdState: z
    .boolean()
    .optional()
    .describe('Colour the headline value on status pages by its threshold state'),
  source: z.enum(METRIC_SOURCES).optional().describe('push (default) or monitor'),
  monitor: id
    .nullable()
    .optional()
    .describe('Monitor whose recorded value is shown (source monitor)'),
  visible: z.boolean().optional().describe('Publish on the listed status pages'),
  statusPages: z.array(id).max(100).optional().describe('Status pages that show the metric'),
  order: z.number().int().optional(),
})

export const metricUpdateSchema = metricCreateSchema.partial()

/** `PUT /api/orgs/:orgId/status-pages/:id/metrics`: the page's metrics in display order (#280). */
export const pageMetricsBody = z.object({
  metrics: z
    .array(id)
    .max(50)
    .describe('Metric ids in display order; every other metric is removed from the page'),
})

export type MetricCreateInput = z.infer<typeof metricCreateSchema>
export type MetricUpdateInput = z.infer<typeof metricUpdateSchema>

const point = z.object({
  value: z.number().finite().min(-METRIC_MAX_ABS_VALUE).max(METRIC_MAX_ABS_VALUE),
  timestamp: z
    .union([z.number().finite().positive(), z.iso.datetime({ offset: true })])
    .optional()
    .describe('Unix seconds (or milliseconds) or an ISO 8601 date; defaults to now'),
})

/** A batch of points (also the input of the `push_metric_points` MCP tool). */
export const metricPointsBatchSchema = z.object({
  points: z.array(point).min(1).max(METRIC_MAX_POINTS_PER_PUSH),
})

export const metricPointsSchema = z.union([metricPointsBatchSchema, point])

export type MetricPointInput = z.infer<typeof point>

/** The points of a push body, single-point bodies included. */
export const pointsOf = (body: z.infer<typeof metricPointsSchema>): MetricPointInput[] =>
  'points' in body ? body.points : [body]
