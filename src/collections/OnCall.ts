import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup } from '@/i18n/admin'
import {
  ESCALATION_TARGET_TYPES,
  MAX_ESCALATION_REPEATS,
  ROTATION_TYPES,
  ROTATION_UNITS,
  WEEKDAYS,
} from '@/lib/on-call'
import {
  escalationPolicyBeforeChange,
  onCallAfterChange,
  onCallAfterDelete,
  onCallScheduleBeforeChange,
} from '@/server/on-call/hooks'

const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }))

/**
 * On-call schedules (#145): layers of rotating members (daily, weekly or custom shifts handing off
 * at a wall-clock time in a time zone, optionally restricted to windows of the week) and overrides.
 * "Who is on call" is computed by `src/lib/on-call.ts`; the `beforeChange` hook checks that every
 * member belongs to the organization and that times and zones are valid.
 */
export const OnCallSchedules: CollectionConfig = {
  slug: 'on-call-schedules',
  admin: {
    group: adminGroup('monitoring'),
    useAsTitle: 'name',
    defaultColumns: ['name', 'timezone', 'updatedAt'],
  },
  access: {
    read: orgScoped('on-call:read'),
    create: orgScoped('on-call:manage'),
    update: orgScoped('on-call:manage'),
    delete: orgScoped('on-call:manage'),
  },
  hooks: {
    beforeChange: [onCallScheduleBeforeChange],
    afterChange: [onCallAfterChange('schedule')],
    afterDelete: [onCallAfterDelete('schedule')],
  },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'name', type: 'text', required: true, maxLength: 100 },
    { name: 'description', type: 'textarea', maxLength: 1000 },
    { name: 'timezone', type: 'text', required: true, defaultValue: 'UTC' },
    {
      name: 'layers',
      type: 'array',
      maxRows: 10,
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'name', type: 'text', maxLength: 100 },
            // Empty: the schedule's time zone.
            { name: 'timezone', type: 'text' },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'rotation',
              type: 'select',
              required: true,
              defaultValue: 'weekly',
              options: options(ROTATION_TYPES),
            },
            { name: 'customLength', type: 'number', min: 1, max: 8760 },
            {
              name: 'customUnit',
              type: 'select',
              defaultValue: 'days',
              options: options(ROTATION_UNITS),
            },
          ],
        },
        {
          type: 'row',
          fields: [
            { name: 'handoffTime', type: 'text', required: true, defaultValue: '09:00' },
            // `YYYY-MM-DD` in the layer's time zone (a calendar date, not an instant).
            { name: 'startDate', type: 'text', required: true },
          ],
        },
        // Ordered: the rotation follows this order.
        { name: 'members', type: 'relationship', relationTo: 'users', hasMany: true },
        {
          name: 'restrictions',
          type: 'array',
          maxRows: 14,
          fields: [
            {
              name: 'days',
              type: 'select',
              hasMany: true,
              required: true,
              options: options(WEEKDAYS),
            },
            {
              type: 'row',
              fields: [
                { name: 'start', type: 'text', required: true },
                { name: 'end', type: 'text', required: true },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'overrides',
      type: 'array',
      maxRows: 200,
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'user', type: 'relationship', relationTo: 'users', required: true },
            { name: 'start', type: 'date', required: true },
            { name: 'end', type: 'date', required: true },
          ],
        },
        { name: 'note', type: 'text', maxLength: 200 },
      ],
    },
  ],
  timestamps: true,
}

/**
 * Escalation policies (#145): ordered steps, each paging its targets (the member on call in a
 * schedule, a member, or any notification channel) and waiting `escalateAfterMinutes` for an
 * acknowledgement before the next step; optionally repeated. Monitors reference a policy
 * (`monitors.escalationPolicy`); the escalation itself runs as BullMQ delayed jobs
 * (`src/server/on-call/escalation.ts`).
 */
export const EscalationPolicies: CollectionConfig = {
  slug: 'escalation-policies',
  admin: {
    group: adminGroup('monitoring'),
    useAsTitle: 'name',
    defaultColumns: ['name', 'repeat', 'updatedAt'],
  },
  access: {
    read: orgScoped('escalation-policy:read'),
    create: orgScoped('escalation-policy:manage'),
    update: orgScoped('escalation-policy:manage'),
    delete: orgScoped('escalation-policy:manage'),
  },
  hooks: {
    beforeChange: [escalationPolicyBeforeChange],
    afterChange: [onCallAfterChange('policy')],
    afterDelete: [onCallAfterDelete('policy')],
  },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'name', type: 'text', required: true, maxLength: 100 },
    { name: 'description', type: 'textarea', maxLength: 1000 },
    {
      name: 'repeat',
      type: 'number',
      defaultValue: 0,
      min: 0,
      max: MAX_ESCALATION_REPEATS,
    },
    {
      name: 'steps',
      type: 'array',
      minRows: 1,
      maxRows: 20,
      fields: [
        {
          name: 'escalateAfterMinutes',
          type: 'number',
          required: true,
          defaultValue: 10,
          min: 1,
          max: 1440,
        },
        {
          name: 'targets',
          type: 'array',
          minRows: 1,
          maxRows: 20,
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'type',
                  type: 'select',
                  required: true,
                  options: options(ESCALATION_TARGET_TYPES),
                },
                { name: 'schedule', type: 'relationship', relationTo: 'on-call-schedules' },
                { name: 'user', type: 'relationship', relationTo: 'users' },
                { name: 'channel', type: 'relationship', relationTo: 'notifications' },
              ],
            },
          ],
        },
      ],
    },
  ],
  timestamps: true,
}
