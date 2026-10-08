import type { Access, CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'

const localApiOnly: Access = () => false

/**
 * Per-location heartbeat aggregates of multi-location monitors (#92), one row per
 * `(monitor, location, hour)`, kept for 30 days. A separate series next to `stat-*` (which keep the
 * monitor-wide figures, computed from the quorum status), so the global rollups are unchanged.
 * Same columns and maths as `StatFields.ts` (`src/server/stats/location-stats.ts`).
 * Written only by the worker through the Local API; read like `stat-*`, scoped to the organizations in
 * which the user holds `monitor:read` (#245).
 */
export const StatLocationHourly: CollectionConfig = {
  slug: 'stat-location-hourly',
  labels: {
    singular: adminT('marmot:stats:locationHour:label'),
    plural: adminT('marmot:stats:locationHour:label'),
  },
  admin: {
    group: adminGroup('statistics'),
    description: adminT('marmot:stats:locationHour:description'),
    defaultColumns: ['monitor', 'location', 'timestamp', 'up', 'down', 'ping'],
    hideAPIURL: true,
  },
  access: {
    read: orgScoped('monitor:read'),
    create: localApiOnly,
    update: localApiOnly,
    delete: localApiOnly,
  },
  timestamps: false,
  indexes: [{ fields: ['monitor', 'location', 'timestamp'], unique: true }],
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
      name: 'location',
      type: 'text',
      required: true,
      admin: { description: adminT('marmot:stats:locationDescription') },
    },
    {
      name: 'timestamp',
      type: 'number',
      required: true,
      index: true,
      admin: { description: adminT('marmot:stats:locationHour:timestampDescription') },
    },
    { name: 'up', type: 'number', required: true, defaultValue: 0 },
    { name: 'down', type: 'number', required: true, defaultValue: 0 },
    {
      name: 'ping',
      type: 'number',
      admin: { description: adminT('marmot:stats:pingDescription') },
    },
    { name: 'pingMin', type: 'number' },
    { name: 'pingMax', type: 'number' },
    {
      name: 'extras',
      type: 'json',
      admin: { description: adminT('marmot:stats:extrasDescription') },
    },
  ],
}
