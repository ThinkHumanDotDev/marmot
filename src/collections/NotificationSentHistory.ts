import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'

/**
 * Which expiry warnings were already delivered: one row per `(type, monitor, days)` threshold.
 * Mirrors Uptime Kuma's `notification_sent_history` table. Written only by the worker
 * (`src/server/jobs/expiry-history.ts`); the compound unique index is what dedupes a threshold that
 * two concurrent checks try to record at the same time. Rows of a monitor are deleted with it and
 * whenever a new certificate (or a renewed domain) is seen.
 *
 * Certificate transparency alerts (#143, `src/server/jobs/ct-alerts.ts`) keep one `ct` row per
 * certificate already announced, keyed by `fingerprint` (`days` is 0). Expiry rows store an empty
 * fingerprint so the unique index works the same on Postgres and MongoDB.
 *
 * Issue-tracker channels (#149, `src/server/notifications/issue-state.ts`) keep one `issue` row per
 * open outage, channel and target: `fingerprint` is `<channel id>:<repository or project>`,
 * `externalId` the ticket (issue number, key or id) that reminders comment on and the recovery
 * closes. The row is deleted when the issue is closed.
 */
export const EXPIRY_NOTIFICATION_TYPES = ['certificate', 'domain'] as const
export type ExpiryNotificationType = (typeof EXPIRY_NOTIFICATION_TYPES)[number]
export const SENT_HISTORY_TYPES = [...EXPIRY_NOTIFICATION_TYPES, 'ct', 'issue'] as const
export type SentHistoryType = (typeof SENT_HISTORY_TYPES)[number]

export const NotificationSentHistory: CollectionConfig = {
  slug: 'notification-sent-history',
  admin: {
    group: adminGroup('monitoring'),
    defaultColumns: ['monitor', 'type', 'days', 'fingerprint', 'createdAt'],
    description: adminT('marmot:notificationSentHistory:description'),
  },
  access: {
    read: orgScoped('monitor:read'),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  indexes: [{ fields: ['type', 'monitor', 'days', 'fingerprint'], unique: true }],
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
      options: SENT_HISTORY_TYPES.map((value) => ({ label: value, value })),
    },
    {
      name: 'days',
      type: 'number',
      required: true,
      min: 0,
      admin: { description: adminT('marmot:notificationSentHistory:daysDescription') },
    },
    {
      name: 'fingerprint',
      type: 'text',
      defaultValue: '',
      admin: { description: adminT('marmot:notificationSentHistory:fingerprintDescription') },
    },
    {
      name: 'externalId',
      type: 'text',
      admin: { description: adminT('marmot:notificationSentHistory:externalIdDescription') },
    },
  ],
  timestamps: true,
}
