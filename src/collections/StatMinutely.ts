import { buildStatCollection } from './StatFields'

/** 1-minute buckets; kept for 24 hours. Backs the 24h uptime/ping figures. */
export const StatMinutely = buildStatCollection({
  slug: 'stat-minutely',
  label: 'Stats (minutely)',
  bucket: 'minute',
})
