import type { Access, CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { METRIC_GRANULARITIES } from '@/lib/metrics'

const localApiOnly: Access = () => false

/**
 * Rollups of pushed metric points (#155): one row per `(metric, granularity, bucket)` with the
 * count, sum, min, max and latest value of the points that fell into it, so every aggregation
 * (average, sum, last, max) can be computed at read time. Buckets and retention match the monitor
 * rollups: minutely rows for 24 hours, hourly for 30 days, daily for `keepDataPeriodDays`
 * (`src/server/jobs/retention.ts`). Written by `src/server/metrics/ingest.ts` only.
 */
export const MetricStats: CollectionConfig = {
  slug: 'metric-stats',
  admin: {
    group: adminGroup('statistics'),
    description: adminT('marmot:metrics:statsDescription'),
    defaultColumns: ['metric', 'granularity', 'timestamp', 'count', 'sum', 'last'],
    hideAPIURL: true,
  },
  access: {
    read: orgScoped('metric:read'),
    create: localApiOnly,
    update: localApiOnly,
    delete: localApiOnly,
  },
  timestamps: false,
  indexes: [{ fields: ['metric', 'granularity', 'timestamp'], unique: true }],
  fields: [
    {
      name: 'metric',
      type: 'relationship',
      relationTo: 'metrics',
      required: true,
      index: true,
      maxDepth: 0,
    },
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      maxDepth: 0,
    },
    {
      name: 'granularity',
      type: 'select',
      required: true,
      options: [...METRIC_GRANULARITIES],
      index: true,
    },
    /** Unix seconds of the bucket start. */
    { name: 'timestamp', type: 'number', required: true, index: true },
    { name: 'count', type: 'number', required: true, defaultValue: 0 },
    { name: 'sum', type: 'number', required: true, defaultValue: 0 },
    { name: 'min', type: 'number', required: true },
    { name: 'max', type: 'number', required: true },
    /** Value of the newest point of the bucket, and its time (unix ms). */
    { name: 'last', type: 'number', required: true },
    { name: 'lastAt', type: 'number', required: true },
  ],
}
