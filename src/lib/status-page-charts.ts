/**
 * Public latency charts of status page components (#113): the vocabulary shared by the server
 * (`src/server/status-pages/latency-charts.ts`), the API route and the client views. Imports
 * nothing server-only.
 */

/** Periods visitors can pick. */
export const PUBLIC_CHART_RANGES = ['1d', '7d', '30d'] as const
export type PublicChartRange = (typeof PUBLIC_CHART_RANGES)[number]
export const DEFAULT_PUBLIC_CHART_RANGE: PublicChartRange = '1d'

export const isPublicChartRange = (value: unknown): value is PublicChartRange =>
  typeof value === 'string' && (PUBLIC_CHART_RANGES as readonly string[]).includes(value)

/** The percentiles a public chart draws. */
export const PUBLIC_PERCENTILES = ['p50', 'p95', 'p99'] as const
export type PublicPercentile = (typeof PUBLIC_PERCENTILES)[number]
export type PublicPercentiles = Record<PublicPercentile, number | null>

/** Path of the charts below a page's base path (`/status/<slug>`, or `''` on a custom domain). */
export const CHARTS_PATH = '/monitors'

/** `/monitors/<componentId>`: one component's charts. */
export const componentChartPath = (componentId: string): string =>
  `${CHARTS_PATH}/${encodeURIComponent(componentId)}`

/** Payload array row ids (ObjectId hex on every database adapter). */
export const COMPONENT_ID_PATTERN = /^[0-9a-f]{24}$/
