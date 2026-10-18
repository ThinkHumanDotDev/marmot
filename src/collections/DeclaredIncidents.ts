import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import {
  DECLARED_INCIDENT_SEVERITIES,
  DECLARED_INCIDENT_STATUSES,
  DECLARED_TIMELINE_TYPES,
  MAX_ACTION_ITEMS,
  POSTMORTEM_STATUSES,
} from '@/lib/declared-incidents'
import {
  declaredIncidentAfterChange,
  declaredIncidentBeforeChange,
} from '@/server/declared-incidents/hooks'

const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }))

/**
 * Declared incidents (#101): the internal incident-response record — severity, commander, status
 * workflow, an append-only timeline and a postmortem. Members write through the Local API with
 * `overrideAccess: false` (`/api/orgs/:orgId/declared-incidents/**`); the `beforeChange` hook
 * enforces the workflow for every writer (allowed transitions, read-only once closed or canceled,
 * timeline derived from the change, postmortem required to close). Public communication stays in
 * the status-page `incidents` collection, linked through `statusPageIncident`.
 */
export const DeclaredIncidents: CollectionConfig = {
  slug: 'declared-incidents',
  admin: {
    group: adminGroup('monitoring'),
    useAsTitle: 'title',
    defaultColumns: ['title', 'severity', 'status', 'commander', 'startedAt'],
    description: adminT('marmot:declaredIncidents:description'),
  },
  access: {
    read: orgScoped('declared-incident:read'),
    create: orgScoped('declared-incident:create'),
    update: orgScoped('declared-incident:update'),
    delete: orgScoped('declared-incident:delete'),
  },
  hooks: {
    beforeChange: [declaredIncidentBeforeChange],
    afterChange: [declaredIncidentAfterChange],
  },
  indexes: [{ fields: ['organization', 'startedAt'] }, { fields: ['status', 'nextReminderAt'] }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'title', type: 'text', required: true, maxLength: 200 },
    {
      type: 'row',
      fields: [
        {
          name: 'severity',
          type: 'select',
          required: true,
          defaultValue: 'major',
          options: options(DECLARED_INCIDENT_SEVERITIES),
        },
        {
          name: 'status',
          type: 'select',
          required: true,
          defaultValue: 'open',
          index: true,
          options: options(DECLARED_INCIDENT_STATUSES),
          admin: { description: adminT('marmot:declaredIncidents:statusDescription') },
        },
      ],
    },
    { name: 'summary', type: 'textarea' },
    {
      type: 'row',
      fields: [
        { name: 'commander', type: 'relationship', relationTo: 'users', index: true },
        { name: 'declaredBy', type: 'relationship', relationTo: 'users' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'startedAt', type: 'date', required: true, index: true },
        { name: 'mitigatedAt', type: 'date' },
        { name: 'resolvedAt', type: 'date' },
        { name: 'closedAt', type: 'date' },
        { name: 'canceledAt', type: 'date' },
      ],
    },
    {
      name: 'monitorIncident',
      type: 'relationship',
      relationTo: 'monitor-incidents',
      admin: { description: adminT('marmot:declaredIncidents:monitorIncidentDescription') },
    },
    {
      name: 'statusPageIncident',
      type: 'relationship',
      relationTo: 'incidents',
      admin: { description: adminT('marmot:declaredIncidents:statusPageIncidentDescription') },
    },
    {
      name: 'postmortem',
      type: 'group',
      fields: [
        {
          name: 'status',
          type: 'select',
          defaultValue: 'none',
          options: options(POSTMORTEM_STATUSES),
        },
        { name: 'content', type: 'textarea' },
        {
          type: 'row',
          fields: [
            { name: 'approvedBy', type: 'relationship', relationTo: 'users' },
            { name: 'approvedAt', type: 'date' },
          ],
        },
        {
          // Structured follow-ups (#285), kept apart from the Markdown so an issue tracker can
          // create tickets from them and record the link.
          name: 'actionItems',
          type: 'array',
          maxRows: MAX_ACTION_ITEMS,
          fields: [
            { name: 'title', type: 'text', required: true, maxLength: 500 },
            {
              type: 'row',
              fields: [
                { name: 'owner', type: 'relationship', relationTo: 'users' },
                { name: 'dueDate', type: 'text', maxLength: 10 },
                { name: 'done', type: 'checkbox', defaultValue: false },
              ],
            },
            { name: 'ticketUrl', type: 'text', maxLength: 2000 },
          ],
        },
      ],
    },
    {
      name: 'postmortemSkipped',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: adminT('marmot:declaredIncidents:postmortemSkippedDescription') },
    },
    {
      // Reminder bookkeeping (`src/server/declared-incidents/reminders.ts`).
      type: 'row',
      fields: [
        { name: 'lastActivityAt', type: 'date' },
        { name: 'nextReminderAt', type: 'date', index: true },
        { name: 'remindersSent', type: 'number', defaultValue: 0 },
        { name: 'lastReminderAt', type: 'date' },
      ],
    },
    {
      name: 'timeline',
      type: 'array',
      admin: { description: adminT('marmot:declaredIncidents:timelineDescription') },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'type',
              type: 'select',
              required: true,
              options: options(DECLARED_TIMELINE_TYPES),
            },
            { name: 'at', type: 'date', required: true },
            { name: 'by', type: 'relationship', relationTo: 'users' },
          ],
        },
        {
          type: 'row',
          fields: [
            { name: 'from', type: 'text' },
            { name: 'to', type: 'text' },
          ],
        },
        { name: 'message', type: 'textarea' },
      ],
    },
  ],
  timestamps: true,
}
