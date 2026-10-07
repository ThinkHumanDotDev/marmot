import type { CollectionBeforeDeleteHook, CollectionConfig } from 'payload'

import { orgScoped, superadminOnly } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import {
  NOTIFICATION_BATCH_STATES,
  NOTIFICATION_EVENTS,
  SUBSCRIBER_CHANNELS,
} from '@/lib/status-page-subscribers'

const removeDeliveries: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.delete({
    collection: 'subscriber-deliveries',
    where: { notification: { equals: id } },
    depth: 0,
    req,
    overrideAccess: true,
  })
}

/**
 * One announcement to the subscribers of a status page (#104): created for every incident update
 * and maintenance event of a page with subscriptions on, then either sent at once (`auto`) or held
 * as a draft (`pending_review`) until someone with `subscriber:send` sends or discards it. The
 * content is a snapshot taken when the event happened; per-subscriber outcomes live in
 * `subscriber-deliveries`. Written by server code only (`src/server/status-pages/subscribers`).
 */
export const SubscriberNotifications: CollectionConfig = {
  slug: 'subscriber-notifications',
  admin: {
    useAsTitle: 'title',
    group: adminGroup('statusPages'),
    defaultColumns: ['title', 'event', 'state', 'statusPage', 'createdAt'],
  },
  access: {
    read: orgScoped('subscriber:read'),
    create: superadminOnly,
    update: superadminOnly,
    delete: orgScoped('subscriber:send'),
  },
  hooks: { beforeDelete: [removeDeliveries] },
  indexes: [{ fields: ['statusPage', 'state'] }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    {
      name: 'statusPage',
      type: 'relationship',
      relationTo: 'status-pages',
      required: true,
      index: true,
    },
    {
      // Unique per page and event (`incident:<id>:<update id>`, `maintenance:<occurrence>:<type>:…`):
      // an event delivered twice (retries, two processes) creates one notification.
      name: 'dedupeKey',
      type: 'text',
      required: true,
      unique: true,
      admin: { hidden: true },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'event',
          type: 'select',
          required: true,
          options: NOTIFICATION_EVENTS.map((value) => ({ label: value, value })),
        },
        {
          name: 'state',
          type: 'select',
          required: true,
          defaultValue: 'pending_review',
          index: true,
          options: NOTIFICATION_BATCH_STATES.map((value) => ({ label: value, value })),
        },
      ],
    },
    { name: 'title', type: 'text', required: true },
    {
      // Incident status or maintenance occurrence state at the time of the event.
      name: 'status',
      type: 'text',
    },
    { name: 'message', type: 'textarea' },
    {
      name: 'window',
      type: 'group',
      admin: { description: adminT('marmot:subscriberNotifications:windowDescription') },
      fields: [
        { name: 'start', type: 'date' },
        { name: 'end', type: 'date' },
        { name: 'reminderMinutes', type: 'number' },
      ],
    },
    {
      // Affected component ids; empty = the whole page (every subscriber).
      name: 'components',
      type: 'text',
      hasMany: true,
    },
    { name: 'incident', type: 'relationship', relationTo: 'incidents' },
    { name: 'incidentUpdateId', type: 'text' },
    { name: 'maintenance', type: 'relationship', relationTo: 'maintenance' },
    { name: 'occurrence', type: 'relationship', relationTo: 'maintenance-occurrences' },
    {
      // Public id of the incident or maintenance occurrence: messages link to its permalink (#107).
      name: 'eventPublicId',
      type: 'text',
    },
    { name: 'occurredAt', type: 'date', required: true },
    {
      name: 'channels',
      type: 'select',
      hasMany: true,
      options: SUBSCRIBER_CHANNELS.map((value) => ({ label: value, value })),
      admin: { description: adminT('marmot:subscriberNotifications:channelsDescription') },
    },
    {
      type: 'row',
      fields: [
        { name: 'recipientCount', type: 'number', admin: { readOnly: true } },
        { name: 'sendingStartedAt', type: 'date', admin: { readOnly: true } },
        { name: 'completedAt', type: 'date', admin: { readOnly: true } },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'approvedBy', type: 'relationship', relationTo: 'users' },
        { name: 'approvedAt', type: 'date' },
        { name: 'discardedBy', type: 'relationship', relationTo: 'users' },
        { name: 'discardedAt', type: 'date' },
      ],
    },
  ],
  timestamps: true,
}
