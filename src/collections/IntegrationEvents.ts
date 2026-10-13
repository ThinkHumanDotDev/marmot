import type { CollectionConfig } from 'payload'

import { orgScoped, superadminOnly } from '@/access/org-scoped'
import { adminGroup } from '@/i18n/admin'
import { INTEGRATION_EVENT_SOURCES } from '@/lib/inbound-alerts'

/**
 * Event log of inbound integrations (#152): one row per received payload or message with the
 * redacted payload (cut at `EVENT_PAYLOAD_MAX_LENGTH`) and, per alert, the rule that matched and the
 * action taken (`results`). Written by the server only; the newest `EVENTS_PER_INTEGRATION` rows are
 * kept per integration, and rows go with their integration.
 */
export const IntegrationEvents: CollectionConfig = {
  slug: 'integration-events',
  admin: {
    group: adminGroup('monitoring'),
    defaultColumns: ['integration', 'source', 'alertCount', 'receivedAt'],
  },
  access: {
    read: orgScoped('integration:read'),
    create: superadminOnly,
    update: superadminOnly,
    delete: superadminOnly,
  },
  indexes: [{ fields: ['integration', 'receivedAt'] }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
    },
    {
      name: 'integration',
      type: 'relationship',
      relationTo: 'integrations',
      required: true,
      index: true,
    },
    { name: 'receivedAt', type: 'date', required: true },
    {
      name: 'source',
      type: 'select',
      required: true,
      defaultValue: 'webhook',
      options: INTEGRATION_EVENT_SOURCES.map((value) => ({ value, label: value })),
    },
    { name: 'alertCount', type: 'number', defaultValue: 0 },
    { name: 'droppedCount', type: 'number', defaultValue: 0 },
    { name: 'payload', type: 'textarea' },
    // `[{ dedupKey, status, title, rule, outcome, actions, error }]`
    { name: 'results', type: 'json' },
  ],
  timestamps: true,
}
