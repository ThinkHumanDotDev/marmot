import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionConfig,
  FieldAccess,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { isWebhookEventSelector, normalizeWebhookSelectors } from '@/lib/webhook-events'
import { translateError } from '@/server/errors'
import { userLocale } from '@/server/request-locale'
import { webhookUrlProblem } from '@/server/webhooks/url'
import { generateWebhookSecret } from '@/server/webhooks/signature'

/** Written by the server only (`overrideAccess: true` bypasses field access). */
const serverOnly: FieldAccess = () => false

/**
 * New endpoints get a signing secret; re-enabling an endpoint clears its failure streak and the
 * reason it was disabled.
 */
const prepareEndpoint: CollectionBeforeChangeHook = ({ data, operation, originalDoc }) => {
  if (operation === 'create' && !data.secret) data.secret = generateWebhookSecret()
  if (Array.isArray(data.events)) {
    data.events = normalizeWebhookSelectors(
      data.events.filter((v: unknown) => typeof v === 'string'),
    )
  }
  if (operation === 'update' && data.active === true && originalDoc?.active === false) {
    data.consecutiveFailures = 0
    data.disabledReason = null
    data.disabledAt = null
  }
  return data
}

/** The delivery log references the endpoint with a NOT NULL column on Postgres. */
const removeDeliveries: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.delete({
    collection: 'webhook-deliveries',
    where: { endpoint: { equals: id } },
    depth: 0,
    req,
    overrideAccess: true,
  })
}

/**
 * Outbound event webhooks of an organization (#157, `webhook:*` permissions, admins by default).
 * Events matching `events` are POSTed to `url`, signed with `secret` (`X-Marmot-Signature`, see
 * `src/server/webhooks/signature.ts`); deliveries go through the notifications queue and are logged
 * in `webhook-deliveries`.
 *
 * The secret is generated on create and never readable through the API: the create and rotate
 * routes (`/api/orgs/:orgId/webhooks`) return it once. After a rotation the previous secret keeps
 * signing alongside the new one until `previousSecretExpiresAt`.
 */
export const WebhookEndpoints: CollectionConfig = {
  slug: 'webhook-endpoints',
  admin: {
    useAsTitle: 'url',
    group: adminGroup('access'),
    defaultColumns: ['url', 'organization', 'active', 'consecutiveFailures', 'lastDeliveryAt'],
    description: adminT('marmot:webhookEndpoints:description'),
  },
  access: {
    read: orgScoped('webhook:read'),
    create: orgScoped('webhook:manage'),
    update: orgScoped('webhook:manage'),
    delete: orgScoped('webhook:manage'),
  },
  hooks: { beforeChange: [prepareEndpoint], beforeDelete: [removeDeliveries] },
  indexes: [{ fields: ['organization', 'active'] }],
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
      name: 'url',
      type: 'text',
      required: true,
      validate: (
        value: unknown,
        { req, previousValue }: { req: { user?: unknown }; previousValue?: unknown },
      ) => {
        // Only new URLs are checked: bookkeeping writes of an endpoint saved before the outbound
        // guard was turned on must not fail (delivery refuses the address anyway).
        if (previousValue !== undefined && value === previousValue) return true
        const problem = webhookUrlProblem(value)
        return problem ? translateError(userLocale(req.user), problem.key, problem.values) : true
      },
    },
    { name: 'description', type: 'text', maxLength: 200 },
    {
      name: 'events',
      type: 'json',
      required: true,
      admin: { description: adminT('marmot:webhookEndpoints:eventsDescription') },
      validate: (value: unknown, { req }: { req: { user?: unknown } }) => {
        const locale = userLocale(req.user)
        if (!Array.isArray(value) || value.length === 0) {
          return translateError(locale, 'webhookEventsRequired')
        }
        const unknown = value.find((entry) => !isWebhookEventSelector(entry))
        return unknown === undefined
          ? true
          : translateError(locale, 'webhookEventUnknown', { event: String(unknown) })
      },
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    {
      name: 'secret',
      type: 'text',
      access: { read: serverOnly, create: serverOnly, update: serverOnly },
      admin: { hidden: true },
    },
    {
      name: 'previousSecret',
      type: 'text',
      access: { read: serverOnly, create: serverOnly, update: serverOnly },
      admin: { hidden: true },
    },
    {
      name: 'previousSecretExpiresAt',
      type: 'date',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'consecutiveFailures',
      type: 'number',
      defaultValue: 0,
      access: { create: serverOnly, update: serverOnly },
      admin: {
        readOnly: true,
        position: 'sidebar',
        description: adminT('marmot:webhookEndpoints:consecutiveFailuresDescription'),
      },
    },
    {
      // `failures` when the worker disabled the endpoint after too many failed deliveries.
      name: 'disabledReason',
      type: 'select',
      options: [{ label: 'failures', value: 'failures' }],
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'disabledAt',
      type: 'date',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'lastDeliveryAt',
      type: 'date',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'lastDeliveryState',
      type: 'select',
      options: [
        { label: 'succeeded', value: 'succeeded' },
        { label: 'failed', value: 'failed' },
      ],
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
  ],
  timestamps: true,
}
