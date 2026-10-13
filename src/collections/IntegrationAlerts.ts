import type { CollectionConfig } from 'payload'

import { orgScoped, superadminOnly } from '@/access/org-scoped'
import { adminGroup } from '@/i18n/admin'
import { ALERT_STATUSES } from '@/lib/inbound-alerts'

/**
 * State of each alert an integration received (#152), one row per integration and dedup key
 * (unique), so retries and repeated firings update the same incidents instead of opening new ones.
 * Written by the server only (`src/server/integrations/ingest.ts`); rows go with their integration.
 */
export const IntegrationAlerts: CollectionConfig = {
  slug: 'integration-alerts',
  admin: {
    group: adminGroup('monitoring'),
    useAsTitle: 'title',
    defaultColumns: ['title', 'integration', 'status', 'lastEventAt'],
  },
  access: {
    read: orgScoped('integration:read'),
    create: superadminOnly,
    update: superadminOnly,
    delete: superadminOnly,
  },
  indexes: [{ fields: ['integration', 'dedupKey'], unique: true }],
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
    { name: 'dedupKey', type: 'text', required: true },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'firing',
      options: ALERT_STATUSES.map((value) => ({ value, label: value })),
    },
    { name: 'title', type: 'text' },
    // The `rules[].id` of the integration that matched when the alert fired.
    { name: 'rule', type: 'text' },
    { name: 'firedAt', type: 'date' },
    { name: 'resolvedAt', type: 'date' },
    { name: 'lastEventAt', type: 'date' },
    { name: 'statusPageIncident', type: 'relationship', relationTo: 'incidents' },
    { name: 'declaredIncident', type: 'relationship', relationTo: 'declared-incidents' },
  ],
  timestamps: true,
}
