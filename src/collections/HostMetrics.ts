import type { Access, CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { HOST_GRANULARITIES } from '@/lib/host-metrics'

const localApiOnly: Access = () => false

/**
 * Rollups of the samples host agents push (#136): one row per `(monitor, granularity, bucket)`
 * whose `series` map holds `[count, sum, min, max, last]` per series key (`cpu`, `disk:/`, …, see
 * `sampleSeries` in `src/lib/host-metrics.ts`). Minutely rows also keep the newest sample
 * (`latest`) for the host summary; they are kept 24 hours, hourly rows 30 days and daily rows for
 * `keepDataPeriodDays` (`src/server/jobs/retention.ts`), so no raw sample outlives a day. Written
 * by `src/server/host-metrics/ingest.ts` only.
 */
export const HostMetrics: CollectionConfig = {
  slug: 'host-metrics',
  admin: {
    group: adminGroup('statistics'),
    description: adminT('marmot:hostMetrics:description'),
    defaultColumns: ['monitor', 'granularity', 'timestamp', 'lastAt'],
    hideAPIURL: true,
  },
  access: {
    read: orgScoped('monitor:read'),
    create: localApiOnly,
    update: localApiOnly,
    delete: localApiOnly,
  },
  timestamps: false,
  indexes: [{ fields: ['monitor', 'granularity', 'timestamp'], unique: true }],
  fields: [
    {
      name: 'monitor',
      type: 'relationship',
      relationTo: 'monitors',
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
      options: [...HOST_GRANULARITIES],
      index: true,
    },
    /** Unix seconds of the bucket start. */
    { name: 'timestamp', type: 'number', required: true, index: true },
    /** Unix ms of the newest sample in the bucket. */
    { name: 'lastAt', type: 'number', required: true },
    { name: 'series', type: 'json', required: true },
    /** The newest sample as the agent sent it (minutely rows only). */
    { name: 'latest', type: 'json' },
  ],
}
