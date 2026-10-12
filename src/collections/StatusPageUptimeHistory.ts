import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { DAY_STATES } from '@/lib/uptime-history'

const never = () => false

/**
 * Preserved daily uptime of status page components (#112): one row per `(statusPage, component,
 * UTC day)`, written by the `status-page-uptime-snapshot` job
 * (`src/server/status-pages/uptime-history.ts`) from `stat-daily` and the important heartbeats
 * before retention prunes them. Retention never deletes these rows, so the daily bars and the
 * monthly history of a page keep their figures after `KEEP_DATA_PERIOD_DAYS` has passed.
 *
 * The row keeps the ingredients of every calculation mode (check counts, time spent DOWN and the
 * time whose state was known); incident-based figures are derived from the incidents, which are
 * kept forever. Rows are written through the Local API only and go with their page.
 */
export const StatusPageUptimeHistory: CollectionConfig = {
  slug: 'status-page-uptime-history',
  labels: {
    singular: adminT('marmot:statusPageUptimeHistory:label'),
    plural: adminT('marmot:statusPageUptimeHistory:label'),
  },
  admin: {
    group: adminGroup('statusPages'),
    description: adminT('marmot:statusPageUptimeHistory:description'),
    defaultColumns: ['statusPage', 'component', 'day', 'up', 'down', 'state'],
    hideAPIURL: true,
  },
  access: {
    read: orgScoped('status-page:read'),
    create: never,
    update: never,
    delete: never,
  },
  timestamps: false,
  indexes: [{ fields: ['statusPage', 'component', 'timestamp'], unique: true }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      maxDepth: 0,
    },
    {
      name: 'statusPage',
      type: 'relationship',
      relationTo: 'status-pages',
      required: true,
      index: true,
      maxDepth: 0,
    },
    {
      // Component id: the group row id of the page (`status-pages.groups[].monitors[].id`).
      name: 'component',
      type: 'text',
      required: true,
      index: true,
    },
    {
      name: 'timestamp',
      type: 'number',
      required: true,
      index: true,
      admin: { description: adminT('marmot:statusPageUptimeHistory:timestampDescription') },
    },
    // `YYYY-MM-DD` and `YYYY-MM` of `timestamp`, for people reading the rows.
    { name: 'day', type: 'text', required: true },
    { name: 'month', type: 'text', required: true, index: true },
    { name: 'up', type: 'number', required: true, defaultValue: 0 },
    { name: 'down', type: 'number', required: true, defaultValue: 0 },
    { name: 'degraded', type: 'number', defaultValue: 0 },
    { name: 'maintenance', type: 'number', defaultValue: 0 },
    {
      name: 'downSeconds',
      type: 'number',
      defaultValue: 0,
      admin: { description: adminT('marmot:statusPageUptimeHistory:downSecondsDescription') },
    },
    {
      name: 'knownSeconds',
      type: 'number',
      defaultValue: 0,
      admin: { description: adminT('marmot:statusPageUptimeHistory:knownSecondsDescription') },
    },
    {
      // Worst state from the checks alone; incident impacts are merged when the bars are built.
      name: 'state',
      type: 'select',
      required: true,
      defaultValue: 'up',
      options: DAY_STATES.map((state) => ({ label: state, value: state })),
    },
  ],
}
