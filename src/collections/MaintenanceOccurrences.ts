import { ValidationError, type CollectionBeforeChangeHook, type CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import {
  OCCURRENCE_STATE_LABELS,
  OCCURRENCE_STATES,
  REMINDER_OFFSETS,
} from '@/lib/maintenance-announcements'
import type { MaintenanceOccurrence } from '@/payload-types'
import { userErrorText } from '@/server/request-locale'

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/** The occurrence's organization is always its maintenance's. */
const deriveOrganization: CollectionBeforeChangeHook<MaintenanceOccurrence> = async ({
  data,
  originalDoc,
  req,
}) => {
  const maintenanceId = relId(data.maintenance ?? originalDoc?.maintenance)
  if (maintenanceId === null) {
    throw new ValidationError({
      collection: 'maintenance-occurrences',
      errors: [
        { message: userErrorText(req, 'maintenanceOccurrenceRequired'), path: 'maintenance' },
      ],
    })
  }
  if (data.maintenance !== undefined || data.organization === undefined) {
    const maintenance = await req.payload.findByID({
      collection: 'maintenance',
      id: maintenanceId,
      depth: 0,
      req,
      overrideAccess: true,
      select: { organization: true },
    })
    data.organization = relId(maintenance.organization) as MaintenanceOccurrence['organization']
  }
  return data
}

/**
 * One concrete window of a maintenance (issue #154): its lifecycle state and the update timeline
 * shown on status pages. Created and advanced by `syncMaintenance()`
 * (`src/server/maintenance/occurrences.ts`) on save, from delayed BullMQ jobs at the planned
 * start/end/reminder times and by the minute reconciler; admins post updates through
 * `POST /api/orgs/:orgId/maintenance/:id/occurrences/:occurrenceId/updates`.
 */
export const MaintenanceOccurrences: CollectionConfig = {
  slug: 'maintenance-occurrences',
  admin: {
    group: adminGroup('monitoring'),
    defaultColumns: ['maintenance', 'start', 'end', 'state', 'organization'],
    description: adminT('marmot:maintenanceOccurrences:description'),
  },
  access: {
    read: orgScoped('maintenance:read'),
    create: orgScoped('maintenance:update'),
    update: orgScoped('maintenance:update'),
    delete: orgScoped('maintenance:update'),
  },
  hooks: { beforeChange: [deriveOrganization] },
  indexes: [{ fields: ['maintenance', 'start'] }, { fields: ['maintenance', 'state'] }],
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
      name: 'maintenance',
      type: 'relationship',
      relationTo: 'maintenance',
      required: true,
      index: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'start',
          type: 'date',
          required: true,
          index: true,
          admin: {
            date: { pickerAppearance: 'dayAndTime' },
            description: adminT('marmot:maintenanceOccurrences:startDescription'),
          },
        },
        {
          name: 'end',
          type: 'date',
          admin: {
            date: { pickerAppearance: 'dayAndTime' },
            description: adminT('marmot:maintenanceOccurrences:endDescription'),
          },
        },
      ],
    },
    {
      name: 'state',
      type: 'select',
      required: true,
      defaultValue: 'scheduled',
      index: true,
      options: OCCURRENCE_STATES.map((value) => ({
        value,
        label: OCCURRENCE_STATE_LABELS[value],
      })),
    },
    {
      type: 'row',
      fields: [
        { name: 'startedAt', type: 'date', admin: { readOnly: true } },
        { name: 'completedAt', type: 'date', admin: { readOnly: true } },
        { name: 'cancelledAt', type: 'date', admin: { readOnly: true } },
      ],
    },
    {
      name: 'remindersSent',
      type: 'select',
      hasMany: true,
      options: REMINDER_OFFSETS.map((value) => ({ value, label: value })),
      admin: { description: adminT('marmot:maintenanceOccurrences:remindersSentDescription') },
    },
    {
      // Same shape as incident updates (#105): status + Markdown message + time.
      name: 'updates',
      type: 'array',
      admin: { description: adminT('marmot:maintenanceOccurrences:updatesDescription') },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'status',
              type: 'select',
              required: true,
              options: OCCURRENCE_STATES.map((value) => ({
                value,
                label: OCCURRENCE_STATE_LABELS[value],
              })),
            },
            {
              name: 'postedAt',
              type: 'date',
              required: true,
              admin: { date: { pickerAppearance: 'dayAndTime' } },
            },
          ],
        },
        { name: 'message', type: 'textarea' },
      ],
    },
  ],
  timestamps: true,
}
