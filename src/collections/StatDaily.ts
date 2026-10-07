import { buildStatCollection } from './StatFields'

/** 1-day (UTC) buckets; kept for `KEEP_DATA_PERIOD_DAYS`. Backs the 1y uptime/ping figures. */
export const StatDaily = buildStatCollection({
  slug: 'stat-daily',
  bucket: 'day',
})
