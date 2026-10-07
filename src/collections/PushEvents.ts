import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { PUSH_BODY_LIMIT_BYTES, PUSH_MSG_MAX_LENGTH, PUSH_SIGNAL_KINDS } from '@/lib/push-schedule'

/**
 * Ping log of push monitors: one row per signal (`success`, `fail`, `start`, `log`) with the message,
 * the first `PUSH_BODY_LIMIT_BYTES` of the request body and the run it belongs to. Written only by
 * `ingestPushSignal()` (`src/server/push/signals.ts`), which keeps the newest
 * `PUSH_EVENTS_PER_MONITOR` rows per monitor. Rows go with their monitor.
 */
export const PUSH_EVENT_SOURCES = ['http', 'email'] as const

export const PushEvents: CollectionConfig = {
  slug: 'push-events',
  admin: {
    group: adminGroup('monitoring'),
    defaultColumns: ['monitor', 'kind', 'msg', 'duration', 'time'],
    description: adminT('marmot:pushEvents:description'),
  },
  access: {
    read: orgScoped('monitor:read'),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  timestamps: false,
  indexes: [{ fields: ['monitor', 'time'] }],
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
    },
    {
      name: 'kind',
      type: 'select',
      required: true,
      options: PUSH_SIGNAL_KINDS.map((value) => ({ label: value, value })),
      admin: { description: adminT('marmot:pushEvents:kindDescription') },
    },
    {
      name: 'source',
      type: 'select',
      defaultValue: 'http',
      options: PUSH_EVENT_SOURCES.map((value) => ({ label: value, value })),
      admin: { description: adminT('marmot:pushEvents:sourceDescription') },
    },
    { name: 'msg', type: 'text', maxLength: PUSH_MSG_MAX_LENGTH },
    {
      name: 'body',
      type: 'textarea',
      // Characters, not bytes: the ingestion already cut the body at the byte limit.
      maxLength: PUSH_BODY_LIMIT_BYTES,
      admin: { description: adminT('marmot:pushEvents:bodyDescription') },
    },
    { name: 'bodyTruncated', type: 'checkbox', defaultValue: false },
    {
      name: 'rid',
      type: 'text',
      maxLength: 64,
      admin: { description: adminT('marmot:pushEvents:ridDescription') },
    },
    { name: 'exitCode', type: 'number' },
    {
      name: 'duration',
      type: 'number',
      admin: { description: adminT('marmot:pushEvents:durationDescription') },
    },
    { name: 'method', type: 'text', maxLength: 10 },
    {
      name: 'time',
      type: 'date',
      required: true,
      index: true,
      admin: { date: { pickerAppearance: 'dayAndTime' } },
    },
  ],
}
