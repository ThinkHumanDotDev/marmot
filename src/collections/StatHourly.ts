import { buildStatCollection } from './StatFields'

/** 1-hour buckets; kept for 30 days. Backs the 30d uptime/ping figures. */
export const StatHourly = buildStatCollection({
  slug: 'stat-hourly',
  bucket: 'hour',
})
