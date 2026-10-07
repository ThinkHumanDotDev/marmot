import type { CollectionConfig } from 'payload'

import { orgScoped, superadminOnly } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { WEBHOOK_DELIVERY_STATES, WEBHOOK_DELIVERY_TRIGGERS } from '@/lib/webhooks'

/**
 * Delivery log of outbound webhooks (#157): one row per event and endpoint (and per manual
 * redelivery or test event), written by the server (`src/server/webhooks/deliver.ts`). The row keeps
 * the envelope that was signed (`body`), so a redelivery sends the very same event; the request
 * headers are stored with the signature redacted, the response body truncated. Rows go with their
 * endpoint and are pruned after `WEBHOOK_DELIVERY_RETENTION_DAYS`.
 */
export const WebhookDeliveries: CollectionConfig = {
  slug: 'webhook-deliveries',
  admin: {
    group: adminGroup('access'),
    defaultColumns: ['eventType', 'endpoint', 'state', 'responseStatus', 'attempts', 'createdAt'],
    description: adminT('marmot:webhookDeliveries:description'),
  },
  access: {
    read: orgScoped('webhook:read'),
    create: superadminOnly,
    update: superadminOnly,
    delete: superadminOnly,
  },
  indexes: [{ fields: ['endpoint', 'createdAt'] }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
    },
    {
      name: 'endpoint',
      type: 'relationship',
      relationTo: 'webhook-endpoints',
      required: true,
      index: true,
    },
    { name: 'eventId', type: 'text', required: true, index: true },
    { name: 'eventType', type: 'text', required: true, index: true },
    {
      name: 'trigger',
      type: 'select',
      required: true,
      defaultValue: 'event',
      options: WEBHOOK_DELIVERY_TRIGGERS.map((value) => ({ label: value, value })),
    },
    {
      name: 'state',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: WEBHOOK_DELIVERY_STATES.map((value) => ({ label: value, value })),
    },
    { name: 'attempts', type: 'number', defaultValue: 0 },
    /** The event envelope `{ id, type, createdAt, orgId, data }` exactly as it is signed. */
    { name: 'body', type: 'json', required: true },
    { name: 'requestHeaders', type: 'json' },
    { name: 'responseStatus', type: 'number' },
    { name: 'responseHeaders', type: 'json' },
    { name: 'responseBody', type: 'text' },
    { name: 'durationMs', type: 'number' },
    { name: 'error', type: 'text' },
    { name: 'deliveredAt', type: 'date' },
    { name: 'redeliveryOf', type: 'relationship', relationTo: 'webhook-deliveries' },
  ],
  timestamps: true,
}
