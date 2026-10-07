import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminT } from '@/i18n/admin'

/**
 * Which expiry warnings were already delivered: one row per `(type, monitor, days)` threshold.
 * Mirrors Uptime Kuma's `notification_sent_history` table. Written only by the worker
 * (`src/server/jobs/expiry-history.ts`); the compound unique index is what dedupes a threshold that
 * two concurrent checks try to record at the same time. Rows of a monitor are deleted with it and
 * whenever a new certificate (or a renewed domain) is seen.
 */
export const EXPIRY_NOTIFICATION_TYPES = ['certificate', 'domain'] as const
export type ExpiryNotificationType = (typeof EXPIRY_NOTIFICATION_TYPES)[number]

export const NotificationSentHistory: CollectionConfig = {
  slug: 'notification-sent-history',
  admin: {
    group: 'Monitoring',
    defaultColumns: ['monitor', 'type', 'days', 'createdAt'],
    description: adminT('marmot:notificationSentHistory:description'),
  },
  access: {
    read: orgScoped('monitor:read'),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  indexes: [{ fields: ['type', 'monitor', 'days'], unique: true }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      index: true,
      admin: { description: adminT('marmot:notificationSentHistory:organizationDescription') },
    },
    {
      name: 'monitor',
      type: 'relationship',
      relationTo: 'monitors',
      required: true,
      index: true,
    },
    {
      name: 'type',
      type: 'select',
      required: true,
      options: EXPIRY_NOTIFICATION_TYPES.map((value) => ({ label: value, value })),
    },
    {
      name: 'days',
      type: 'number',
      required: true,
      min: 0,
      admin: { description: adminT('marmot:notificationSentHistory:daysDescription') },
    },
  ],
  timestamps: true,
}
