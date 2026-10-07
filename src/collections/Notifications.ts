import {
  APIError,
  ValidationError,
  type CollectionAfterChangeHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type FieldHook,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import type { OrgId, UserLike } from '@/access/permissions'
import { childLogger } from '@/lib/logger'
import type { Monitor, Notification } from '@/payload-types'
import { getNotificationProvider } from '@/server/notification-providers'
import {
  normalizeNotificationConfig,
  NotificationConfigError,
  validateNotificationConfig,
} from '@/server/notifications/send'
import { checkServerSmtpChange } from '@/server/notifications/server-smtp'
import { adminT } from '@/i18n/admin'

const log = childLogger('notifications')

const extractId = (value: OrgId | { id: OrgId } | null | undefined): OrgId | null =>
  value === null || value === undefined ? null : typeof value === 'object' ? value.id : value

/**
 * `type` must name a registered provider and `config` must satisfy its schema. Runs in
 * `beforeValidate` so the error surfaces as a normal field validation error (REST 400).
 */
const validateProviderConfig: CollectionBeforeValidateHook<Notification> = ({
  data,
  originalDoc,
}) => {
  if (!data) return data
  const type = data.type ?? originalDoc?.type
  if (!type) return data
  if (!getNotificationProvider(type)) {
    throw new ValidationError({
      collection: 'notifications',
      errors: [{ message: `Unknown notification type "${type}".`, path: 'type' }],
    })
  }
  const config = data.config !== undefined ? data.config : originalDoc?.config
  try {
    data.config = validateNotificationConfig(type, config)
  } catch (error) {
    if (error instanceof NotificationConfigError) {
      throw new ValidationError({
        collection: 'notifications',
        errors: error.issues.length
          ? error.issues.map((issue) => ({
              message: issue.message,
              path: issue.path ? `config.${issue.path}` : 'config',
            }))
          : [{ message: error.message, path: 'config' }],
      })
    }
    throw error
  }
  return data
}

/**
 * `NOTIFICATIONS_SERVER_SMTP`: only allowed users may set up a channel that sends through the
 * server SMTP settings (403), and such a channel has a recipient cap (400). A field hook rather
 * than a collection hook because only field hooks learn whether access control is overridden:
 * trusted server code (`overrideAccess: true`) is exempt from the superadmin rule, never from `off`.
 * Runs before `validateProviderConfig`; both configs are normalised with the provider schema so a
 * re-submitted form compares equal to the stored channel.
 */
const enforceServerSmtpPolicy: FieldHook<Notification> = ({
  data,
  originalDoc,
  operation,
  overrideAccess,
  req,
  value,
}) => {
  if (operation !== 'create' && operation !== 'update') return value
  const type = data?.type ?? originalDoc?.type
  const refusal = checkServerSmtpChange({
    operation,
    type,
    config: normalizeNotificationConfig(
      type,
      data?.config !== undefined ? data.config : originalDoc?.config,
    ),
    originalType: originalDoc?.type,
    originalConfig: normalizeNotificationConfig(originalDoc?.type, originalDoc?.config),
    user: req.user as UserLike | null | undefined,
    overrideAccess,
  })
  if (!refusal) return value
  if (refusal.status === 403) throw new APIError(refusal.message, 403, null, true)
  throw new ValidationError({
    collection: 'notifications',
    errors: [{ message: refusal.message, path: refusal.path }],
  })
}

/** Reset the delivery error whenever a user edits the channel (not on worker outcome writes). */
const clearLastErrorOnEdit: CollectionBeforeChangeHook<Notification> = ({
  data,
  operation,
  req,
}) => {
  if (operation === 'update' && !req.context?.skipNotificationHooks && data.config !== undefined) {
    data.lastError = null
  }
  return data
}

/**
 * Attach a channel to every monitor of its organization that does not have it yet.
 * Exported for the "apply to all existing monitors" action.
 */
export async function attachNotificationToOrgMonitors({
  payload,
  notificationId,
  orgId,
  req,
}: {
  payload: Payload
  notificationId: OrgId
  orgId: OrgId
  req?: PayloadRequest
}): Promise<number> {
  const { docs } = await payload.find({
    collection: 'monitors',
    where: { organization: { equals: orgId } },
    depth: 0,
    limit: 0,
    pagination: false,
    req,
    overrideAccess: true,
  })

  let attached = 0
  for (const monitor of docs as Monitor[]) {
    const current = (monitor.notifications ?? []).map((n) => extractId(n as OrgId | { id: OrgId }))
    if (current.some((id) => id !== null && String(id) === String(notificationId))) continue
    await payload.update({
      collection: 'monitors',
      id: monitor.id,
      data: {
        notifications: [
          ...current.filter((id) => id !== null),
          notificationId,
        ] as Monitor['notifications'],
      },
      depth: 0,
      req,
      overrideAccess: true,
      // The schedule is unchanged; keep the hook from touching Redis.
      context: { skipEngineSync: true },
    })
    attached += 1
  }
  return attached
}

/** Handle the virtual `applyExisting` checkbox: attach to all monitors of the organization. */
const applyToExistingMonitors: CollectionAfterChangeHook<Notification> = async ({
  data,
  doc,
  req,
}) => {
  if (req.context?.skipNotificationHooks || !data?.applyExisting) return doc
  const orgId = extractId(doc.organization)
  if (orgId === null) return doc
  try {
    const attached = await attachNotificationToOrgMonitors({
      payload: req.payload,
      notificationId: doc.id,
      orgId,
      req,
    })
    log.info({ notificationId: doc.id, orgId, attached }, 'attached channel to existing monitors')
  } catch (error) {
    log.error({ err: error, notificationId: doc.id }, 'failed to attach channel to monitors')
    throw error
  }
  return doc
}

/** Ids of the organization's active default channels (for new monitors). */
export async function getDefaultNotificationIds(
  payload: Payload,
  orgId: OrgId,
  req?: PayloadRequest,
): Promise<OrgId[]> {
  const { docs } = await payload.find({
    collection: 'notifications',
    where: {
      and: [
        { organization: { equals: orgId } },
        { isDefault: { equals: true } },
        { active: { equals: true } },
      ],
    },
    depth: 0,
    limit: 100,
    req,
    overrideAccess: true,
  })
  return docs.map((doc) => doc.id)
}

/**
 * `monitors` beforeChange hook: a new monitor created without explicit channels gets the
 * organization's default channels (Uptime Kuma's "Default enabled" behaviour). Callers that pass
 * a deliberate selection (the monitor form, clone) set `context.explicitNotifications`, so
 * an empty selection stays empty.
 */
export const attachDefaultNotifications: CollectionBeforeChangeHook<Monitor> = async ({
  data,
  operation,
  req,
}) => {
  if (operation !== 'create' || req.context?.explicitNotifications) return data
  if (Array.isArray(data.notifications) && data.notifications.length > 0) return data
  const orgId = extractId(data.organization as OrgId | { id: OrgId } | null | undefined)
  if (orgId === null) return data
  try {
    const defaults = await getDefaultNotificationIds(req.payload, orgId, req)
    if (defaults.length > 0) data.notifications = defaults as Monitor['notifications']
  } catch (error) {
    log.warn({ err: error, orgId }, 'failed to load default notification channels')
  }
  return data
}

export const Notifications: CollectionConfig = {
  slug: 'notifications',
  admin: {
    useAsTitle: 'name',
    group: 'Monitoring',
    defaultColumns: ['name', 'type', 'isDefault', 'active', 'lastSentAt'],
  },
  access: {
    read: orgScoped('notification:read'),
    create: orgScoped('notification:create'),
    update: orgScoped('notification:update'),
    delete: orgScoped('notification:delete'),
  },
  indexes: [{ fields: ['organization', 'isDefault'] }],
  hooks: {
    beforeValidate: [validateProviderConfig],
    beforeChange: [clearLastErrorOnEdit],
    afterChange: [applyToExistingMonitors],
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
    {
      type: 'row',
      fields: [
        { name: 'name', type: 'text', required: true },
        {
          name: 'type',
          type: 'text',
          required: true,
          index: true,
          admin: {
            description: adminT('marmot:notifications:typeDescription'),
          },
        },
      ],
    },
    {
      name: 'config',
      type: 'json',
      required: true,
      defaultValue: {},
      hooks: { beforeValidate: [enforceServerSmtpPolicy] },
      admin: { description: adminT('marmot:notifications:configDescription') },
    },
    {
      name: 'isDefault',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:notifications:isDefaultDescription'),
      },
    },
    {
      name: 'applyExisting',
      type: 'checkbox',
      virtual: true,
      defaultValue: false,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:notifications:applyExistingDescription'),
      },
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      admin: { position: 'sidebar', description: adminT('marmot:notifications:activeDescription') },
    },
    {
      name: 'lastSentAt',
      type: 'date',
      admin: {
        readOnly: true,
        position: 'sidebar',
        date: { pickerAppearance: 'dayAndTime' },
        description: adminT('marmot:notifications:lastSentAtDescription'),
      },
    },
    {
      name: 'lastError',
      type: 'text',
      admin: { readOnly: true, description: adminT('marmot:notifications:lastErrorDescription') },
    },
  ],
  timestamps: true,
}
