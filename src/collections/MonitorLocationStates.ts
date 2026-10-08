import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'

import { HEARTBEAT_STATUSES } from './Heartbeats'

/**
 * Multi-location checks (#92): the state machine's state of one monitor at one location, the
 * per-location counterpart of `monitors.status`. Written only by the engine
 * (`src/server/engine/quorum-store.ts`, Local API with `overrideAccess`) and only for monitors
 * checked from several locations; single-location monitors keep using `monitors.status` alone.
 * The compound unique index keeps one row per `(monitor, locationKey)` on both databases.
 */
export const MonitorLocationStates: CollectionConfig = {
  slug: 'monitor-location-states',
  admin: {
    group: adminGroup('monitoring'),
    defaultColumns: ['monitor', 'locationKey', 'lastStatus', 'lastCheckAt'],
    description: adminT('marmot:monitorLocationStates:description'),
  },
  access: {
    read: orgScoped('monitor:read'),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  timestamps: false,
  indexes: [{ fields: ['monitor', 'locationKey'], unique: true }],
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
      name: 'monitor',
      type: 'relationship',
      relationTo: 'monitors',
      required: true,
      index: true,
      maxDepth: 0,
    },
    {
      name: 'locationKey',
      type: 'text',
      required: true,
      index: true,
      admin: { description: adminT('marmot:monitorLocationStates:locationKeyDescription') },
    },
    {
      name: 'lastStatus',
      type: 'select',
      options: HEARTBEAT_STATUSES.map((s) => ({ label: s, value: s })),
    },
    {
      name: 'settledStatus',
      type: 'select',
      options: HEARTBEAT_STATUSES.map((s) => ({ label: s, value: s })),
    },
    { name: 'retries', type: 'number', defaultValue: 0 },
    { name: 'downCount', type: 'number', defaultValue: 0 },
    { name: 'recoveries', type: 'number', defaultValue: 0 },
    { name: 'lastCheckAt', type: 'date' },
    { name: 'lastPing', type: 'number' },
    { name: 'lastMsg', type: 'text' },
  ],
}
