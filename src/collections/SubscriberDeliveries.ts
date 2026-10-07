import type { CollectionConfig } from 'payload'

import { orgScoped, superadminOnly } from '@/access/org-scoped'
import { adminGroup } from '@/i18n/admin'
import { DELIVERY_STATES, SUBSCRIBER_CHANNELS } from '@/lib/status-page-subscribers'

/**
 * Delivery log: one row per (subscriber notification, subscriber), written by the notifications
 * worker (`src/server/status-pages/subscribers/worker.ts`). Rows go with their subscriber and with
 * their notification.
 */
export const SubscriberDeliveries: CollectionConfig = {
  slug: 'subscriber-deliveries',
  admin: {
    group: adminGroup('statusPages'),
    defaultColumns: ['notification', 'subscriber', 'channel', 'state', 'attempts', 'updatedAt'],
  },
  access: {
    read: orgScoped('subscriber:read'),
    create: superadminOnly,
    update: superadminOnly,
    delete: superadminOnly,
  },
  indexes: [
    { fields: ['notification', 'subscriber'], unique: true },
    { fields: ['notification', 'state'] },
  ],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
    },
    {
      name: 'notification',
      type: 'relationship',
      relationTo: 'subscriber-notifications',
      required: true,
      index: true,
    },
    {
      name: 'subscriber',
      type: 'relationship',
      relationTo: 'status-page-subscribers',
      required: true,
      index: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'channel',
          type: 'select',
          required: true,
          options: SUBSCRIBER_CHANNELS.map((value) => ({ label: value, value })),
        },
        {
          name: 'state',
          type: 'select',
          required: true,
          defaultValue: 'queued',
          options: DELIVERY_STATES.map((value) => ({ label: value, value })),
        },
        { name: 'attempts', type: 'number', defaultValue: 0 },
      ],
    },
    { name: 'error', type: 'text' },
    { name: 'sentAt', type: 'date' },
  ],
  timestamps: true,
}
