import type { CollectionConfig } from 'payload'
import { adminGroup, adminT } from '@/i18n/admin'

/**
 * One row per check result. Written exclusively by the worker (Local API, `overrideAccess: true`).
 * Raw rows are pruned after 24h by the retention job; `important` rows (status transitions) are kept
 * for `KEEP_DATA_PERIOD_DAYS`.
 */
export const HEARTBEAT_STATUSES = ['up', 'down', 'pending', 'maintenance'] as const

export const Heartbeats: CollectionConfig = {
  slug: 'heartbeats',
  admin: {
    group: adminGroup('monitoring'),
    defaultColumns: ['monitor', 'status', 'msg', 'ping', 'time'],
  },
  // TODO(#1): scope reads to the user's organizations once RBAC lands.
  access: {
    read: ({ req }) => Boolean(req.user),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  timestamps: false,
  indexes: [{ fields: ['monitor', 'time'] }, { fields: ['monitor', 'important', 'time'] }],
  fields: [
    {
      name: 'monitor',
      type: 'relationship',
      relationTo: 'monitors',
      required: true,
      index: true,
    },
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      index: true,
      admin: { description: adminT('marmot:heartbeats:organizationDescription') },
    },
    {
      name: 'status',
      type: 'select',
      options: HEARTBEAT_STATUSES.map((s) => ({ label: s, value: s })),
      required: true,
    },
    { name: 'msg', type: 'text' },
    {
      name: 'ping',
      type: 'number',
      admin: { description: adminT('marmot:heartbeats:pingDescription') },
    },
    {
      name: 'duration',
      type: 'number',
      admin: { description: adminT('marmot:heartbeats:durationDescription') },
    },
    {
      name: 'important',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: { description: adminT('marmot:heartbeats:importantDescription') },
    },
    {
      name: 'assertions',
      type: 'json',
      admin: { readOnly: true, description: adminT('marmot:heartbeats:assertionsDescription') },
    },
    { name: 'retries', type: 'number', defaultValue: 0 },
    { name: 'downCount', type: 'number', defaultValue: 0 },
    {
      name: 'time',
      type: 'date',
      required: true,
      index: true,
      admin: { date: { pickerAppearance: 'dayAndTime' } },
    },
  ],
}
