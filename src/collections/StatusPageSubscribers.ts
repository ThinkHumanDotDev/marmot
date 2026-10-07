import { randomBytes } from 'node:crypto'

import {
  ValidationError,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionConfig,
  type PayloadRequest,
  type Where,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { locales } from '@/i18n/locales'
import {
  MAX_SUBSCRIBER_HEADERS,
  SUBSCRIBER_CHANNELS,
  SUBSCRIBER_SOURCES,
  isSubscriberChannel,
  normalizeComponentSelection,
  normalizeTarget,
} from '@/lib/status-page-subscribers'
import type { StatusPage, StatusPageSubscriber } from '@/payload-types'
import type { ErrorKey } from '@/server/errors'
import { userErrorText } from '@/server/request-locale'
import { generateWebhookSecret } from '@/server/webhooks/signature'

import { relId, secretReadAccess } from './shared'

const invalid = (req: PayloadRequest, key: ErrorKey, path: string): never => {
  throw new ValidationError({
    collection: 'status-page-subscribers',
    errors: [{ message: userErrorText(req, key), path }],
  })
}

/** Component ids (group row ids) of a page. */
export function statusPageComponentIds(page: Pick<StatusPage, 'groups'>): Set<string> {
  const ids = new Set<string>()
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) if (row.id) ids.add(String(row.id))
  }
  return ids
}

/** HTTP header names a subscriber may not set (they are Marmot's or the transport's). */
const RESERVED_HEADERS =
  /^(host|content-length|content-type|transfer-encoding|connection|x-marmot-.*)$/i
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/

/**
 * Derives the organization from the page, normalises and validates the target for its channel,
 * keeps only components of the page, and fills the generated fields: the link token, the webhook
 * signing secret, and `confirmedAt` for subscribers an owner added or imported (no opt-in needed).
 */
const prepare: CollectionBeforeChangeHook<StatusPageSubscriber> = async ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  const pageId = relId(data.statusPage ?? originalDoc?.statusPage)
  if (pageId === null) return invalid(req, 'subscriberStatusPageRequired', 'statusPage')
  if (
    operation === 'update' &&
    data.statusPage !== undefined &&
    String(relId(data.statusPage)) !== String(relId(originalDoc?.statusPage))
  ) {
    return invalid(req, 'subscriberStatusPageRequired', 'statusPage')
  }
  const page = await req.payload.findByID({
    collection: 'status-pages',
    id: pageId,
    depth: 0,
    req,
    overrideAccess: true,
    select: { organization: true, groups: true },
  })
  data.organization = relId(page.organization) as StatusPageSubscriber['organization']

  const channel = data.channel ?? originalDoc?.channel
  if (!isSubscriberChannel(channel)) return invalid(req, 'subscriberTargetInvalid', 'channel')
  if (
    operation === 'update' &&
    data.channel !== undefined &&
    data.channel !== originalDoc?.channel
  ) {
    return invalid(req, 'subscriberTargetInvalid', 'channel')
  }
  if (data.target !== undefined || operation === 'create') {
    const check = normalizeTarget(channel, data.target)
    if (!check.ok) return invalid(req, 'subscriberTargetInvalid', 'target')
    data.target = check.target
  }

  if (data.components !== undefined) {
    const known = statusPageComponentIds(page as StatusPage)
    const requested = (data.components ?? []).map(String)
    const kept = normalizeComponentSelection(requested, known)
    if (kept.length !== new Set(requested).size) {
      return invalid(req, 'subscriberComponentsInvalid', 'components')
    }
    data.components = kept
  }

  if (data.headers !== undefined) {
    const rows = data.headers ?? []
    if (channel !== 'webhook' && rows.length > 0) {
      return invalid(req, 'subscriberHeadersInvalid', 'headers')
    }
    if (rows.length > MAX_SUBSCRIBER_HEADERS) {
      return invalid(req, 'subscriberHeadersInvalid', 'headers')
    }
    for (const [i, row] of rows.entries()) {
      const name = String(row?.name ?? '').trim()
      if (
        !HEADER_NAME.test(name) ||
        RESERVED_HEADERS.test(name) ||
        /[\r\n]/.test(row?.value ?? '')
      ) {
        return invalid(req, 'subscriberHeadersInvalid', `headers.${i}.name`)
      }
      row.name = name
    }
  }

  if (operation === 'create') {
    data.token = randomBytes(18).toString('base64url')
    data.source ??= 'self_signup'
    if (data.source !== 'self_signup' && !data.confirmedAt) {
      data.confirmedAt = new Date().toISOString()
    }
  }
  if (channel === 'webhook' && !(data.secret ?? originalDoc?.secret)) {
    data.secret = generateWebhookSecret()
  }
  return data
}

/** Duplicate subscriptions (same page, channel and target) are refused with a readable error. */
const refuseDuplicates: CollectionBeforeChangeHook<StatusPageSubscriber> = async ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  if (operation !== 'create' && data.target === undefined) return data
  const where: Where[] = [
    { statusPage: { equals: relId(data.statusPage ?? originalDoc?.statusPage) } },
    { channel: { equals: data.channel ?? originalDoc?.channel } },
    { target: { equals: data.target } },
  ]
  if (originalDoc?.id !== undefined) where.push({ id: { not_equals: originalDoc.id } })
  const { totalDocs } = await req.payload.count({
    collection: 'status-page-subscribers',
    where: { and: where },
    req,
    overrideAccess: true,
  })
  if (totalDocs > 0) invalid(req, 'subscriberDuplicate', 'target')
  return data
}

/** The delivery log of a subscriber goes with it (it names the subscriber's address). */
const removeDeliveries: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.delete({
    collection: 'subscriber-deliveries',
    where: { subscriber: { equals: id } },
    depth: 0,
    req,
    overrideAccess: true,
  })
}

const hidden = { read: () => false, create: () => false, update: () => false }

/**
 * Visitors (and the people an owner added) who receive a status page's incident and maintenance
 * announcements (#104). Org-scoped; addresses are personal data, so reading them needs
 * `subscriber:read` (members by default). Self sign-ups stay unconfirmed (and receive nothing)
 * until they follow the email link or enter the SMS code. See docs/Status-Pages.md → Subscribers.
 */
export const StatusPageSubscribers: CollectionConfig = {
  slug: 'status-page-subscribers',
  admin: {
    useAsTitle: 'target',
    group: adminGroup('statusPages'),
    defaultColumns: ['target', 'channel', 'statusPage', 'confirmedAt', 'source'],
  },
  access: {
    read: orgScoped('subscriber:read'),
    create: orgScoped('subscriber:manage'),
    update: orgScoped('subscriber:manage'),
    delete: orgScoped('subscriber:manage'),
  },
  hooks: {
    beforeChange: [prepare, refuseDuplicates],
    beforeDelete: [removeDeliveries],
  },
  indexes: [
    { fields: ['statusPage', 'channel', 'target'], unique: true },
    { fields: ['statusPage', 'confirmedAt'] },
  ],
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
      name: 'statusPage',
      type: 'relationship',
      relationTo: 'status-pages',
      required: true,
      index: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'channel',
          type: 'select',
          required: true,
          options: SUBSCRIBER_CHANNELS.map((value) => ({ label: value, value })),
        },
        {
          name: 'target',
          type: 'text',
          required: true,
          index: true,
          admin: { description: adminT('marmot:subscribers:targetDescription') },
        },
      ],
    },
    {
      // Component ids (group row ids of the page); empty = every component.
      name: 'components',
      type: 'text',
      hasMany: true,
      admin: { description: adminT('marmot:subscribers:componentsDescription') },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'source',
          type: 'select',
          defaultValue: 'self_signup',
          options: SUBSCRIBER_SOURCES.map((value) => ({ label: value, value })),
        },
        {
          name: 'confirmedAt',
          type: 'date',
          index: true,
          admin: {
            date: { pickerAppearance: 'dayAndTime' },
            description: adminT('marmot:subscribers:confirmedAtDescription'),
          },
        },
        {
          name: 'locale',
          type: 'select',
          options: locales.map((value) => ({ label: value, value })),
          admin: { description: adminT('marmot:subscribers:localeDescription') },
        },
      ],
    },
    {
      // Random salt of the signed manage/unsubscribe links (see `subscriberLinkToken`).
      name: 'token',
      type: 'text',
      index: true,
      access: hidden,
      admin: { hidden: true },
    },
    {
      // Webhook subscribers: HMAC-SHA256 signing secret of `X-Marmot-Signature`.
      name: 'secret',
      type: 'text',
      access: { read: secretReadAccess('subscriber:manage'), create: () => false },
      admin: {
        readOnly: true,
        condition: (data) => data?.channel === 'webhook',
        description: adminT('marmot:subscribers:secretDescription'),
      },
    },
    {
      // Webhook subscribers: extra request headers (e.g. an Authorization token of the receiver).
      name: 'headers',
      type: 'array',
      access: { read: secretReadAccess('subscriber:manage') },
      admin: { condition: (data) => data?.channel === 'webhook' },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'name', type: 'text', required: true },
            { name: 'value', type: 'text', required: true },
          ],
        },
      ],
    },
    {
      // SMS double opt-in: scrypt-free SHA-256 of the code (short-lived, attempt-limited).
      name: 'verification',
      type: 'group',
      access: hidden,
      admin: { hidden: true },
      fields: [
        { name: 'codeHash', type: 'text' },
        { name: 'expiresAt', type: 'date' },
        { name: 'attempts', type: 'number', defaultValue: 0 },
        { name: 'sentAt', type: 'date' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'lastDeliveredAt', type: 'date', admin: { readOnly: true } },
        { name: 'lastError', type: 'text', admin: { readOnly: true } },
      ],
    },
  ],
  timestamps: true,
}
