import { randomUUID } from 'node:crypto'

import type { CollectionBeforeChangeHook, CollectionConfig } from 'payload'

import { orgScoped, superadminOnly } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import {
  INCIDENT_ACTION_SOURCES,
  INCIDENT_TIMELINE_TYPES,
  MONITOR_INCIDENT_STATUSES,
} from '@/lib/monitor-incidents'
import type { MonitorIncident } from '@/payload-types'

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/**
 * `openKey` is `open:<monitor>` while the incident is unresolved and a random `resolved:<uuid>`
 * afterwards. Its unique index therefore allows at most one unresolved incident per monitor on
 * every database (no partial indexes needed), which is what makes opening idempotent when two
 * beats of the same monitor race.
 */
const deriveOpenKey: CollectionBeforeChangeHook<MonitorIncident> = ({ data, originalDoc }) => {
  const status = data.status ?? originalDoc?.status ?? 'open'
  const monitor = relId(data.monitor ?? originalDoc?.monitor)
  const current = data.openKey ?? originalDoc?.openKey ?? null
  if (status === 'resolved') {
    if (!current || !current.startsWith('resolved:')) data.openKey = `resolved:${randomUUID()}`
  } else if (monitor !== null) {
    data.openKey = `open:${monitor}`
  }
  return data
}

/**
 * Internal monitor incidents (issue #100): one row per outage of a monitor, opened by the engine on
 * the transition to DOWN, acknowledged by a member and resolved on recovery. Written only by the
 * server (`src/server/incidents/`, Local API with `overrideAccess`); members act through
 * `POST /api/orgs/:orgId/monitor-incidents/:id/{acknowledge,resolve,publish}`. Public communication
 * stays in the status-page `incidents` collection (`statusPageIncident` links the two).
 */
export const MonitorIncidents: CollectionConfig = {
  slug: 'monitor-incidents',
  admin: {
    group: adminGroup('monitoring'),
    defaultColumns: ['monitor', 'status', 'startedAt', 'acknowledgedBy', 'resolvedAt'],
    description: adminT('marmot:monitorIncidents:description'),
  },
  access: {
    read: orgScoped('monitor-incident:read'),
    create: superadminOnly,
    update: superadminOnly,
    delete: superadminOnly,
  },
  hooks: { beforeChange: [deriveOpenKey] },
  indexes: [{ fields: ['organization', 'startedAt'] }, { fields: ['monitor', 'startedAt'] }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar', readOnly: true },
    },
    {
      name: 'monitor',
      type: 'relationship',
      relationTo: 'monitors',
      required: true,
      index: true,
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'open',
      index: true,
      options: MONITOR_INCIDENT_STATUSES.map((value) => ({ value, label: value })),
      admin: { description: adminT('marmot:monitorIncidents:statusDescription') },
    },
    {
      name: 'openKey',
      type: 'text',
      unique: true,
      admin: {
        hidden: true,
        description: adminT('marmot:monitorIncidents:openKeyDescription'),
      },
    },
    {
      name: 'cause',
      type: 'text',
      admin: { description: adminT('marmot:monitorIncidents:causeDescription') },
    },
    {
      type: 'row',
      fields: [
        { name: 'startedAt', type: 'date', required: true, index: true },
        { name: 'acknowledgedAt', type: 'date' },
        { name: 'resolvedAt', type: 'date' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'acknowledgedBy', type: 'relationship', relationTo: 'users' },
        {
          name: 'acknowledgedVia',
          type: 'select',
          options: INCIDENT_ACTION_SOURCES.map((value) => ({ value, label: value })),
        },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'resolvedBy', type: 'relationship', relationTo: 'users' },
        {
          name: 'autoResolved',
          type: 'checkbox',
          defaultValue: false,
          admin: { description: adminT('marmot:monitorIncidents:autoResolvedDescription') },
        },
      ],
    },
    {
      // Reminder bookkeeping for the reminder policy (src/server/incidents/reminders.ts, #147).
      type: 'row',
      fields: [
        {
          name: 'remindersSent',
          type: 'number',
          defaultValue: 0,
          admin: { description: adminT('marmot:monitorIncidents:remindersSentDescription') },
        },
        { name: 'lastReminderAt', type: 'date' },
      ],
    },
    {
      name: 'statusPageIncident',
      type: 'relationship',
      relationTo: 'incidents',
      admin: { description: adminT('marmot:monitorIncidents:statusPageIncidentDescription') },
    },
    {
      name: 'timeline',
      type: 'array',
      admin: { description: adminT('marmot:monitorIncidents:timelineDescription') },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'type',
              type: 'select',
              required: true,
              options: INCIDENT_TIMELINE_TYPES.map((value) => ({ value, label: value })),
            },
            { name: 'at', type: 'date', required: true },
          ],
        },
        {
          type: 'row',
          fields: [
            { name: 'by', type: 'relationship', relationTo: 'users' },
            {
              name: 'via',
              type: 'select',
              options: INCIDENT_ACTION_SOURCES.map((value) => ({ value, label: value })),
            },
          ],
        },
        { name: 'message', type: 'textarea' },
      ],
    },
  ],
  timestamps: true,
}
