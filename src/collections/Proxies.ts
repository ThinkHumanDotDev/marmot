import {
  ValidationError,
  type CollectionAfterChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { PROXY_PROTOCOLS } from '@/lib/monitor-resources'
import type { MonitorProxy } from '@/payload-types'

import { detachMonitorRelation, relId, secretReadAccess } from './shared'

/** Trim the host and drop credentials when authentication is off. */
const normalize: CollectionBeforeValidateHook<MonitorProxy> = ({ data, originalDoc }) => {
  if (!data) return data
  if (typeof data.host === 'string') data.host = data.host.trim()
  const auth = data.auth ?? originalDoc?.auth
  if (auth === false) {
    data.username = null
    data.password = null
  } else if (auth) {
    const username = data.username !== undefined ? data.username : originalDoc?.username
    if (!username) {
      throw new ValidationError({
        collection: 'proxies',
        errors: [
          { message: 'A username is required when authentication is on.', path: 'username' },
        ],
      })
    }
  }
  return data
}

/** Only one default proxy per organization (Uptime Kuma `Proxy.save`). */
const keepSingleDefault: CollectionAfterChangeHook<MonitorProxy> = async ({ doc, req }) => {
  if (!doc.default || req.context?.skipProxyDefault) return doc
  const organization = relId(doc.organization)
  if (organization === null) return doc
  await req.payload.update({
    collection: 'proxies',
    where: {
      and: [
        { organization: { equals: organization } },
        { default: { equals: true } },
        { id: { not_equals: doc.id } },
      ],
    },
    data: { default: false },
    depth: 0,
    req,
    overrideAccess: true,
    context: { skipProxyDefault: true },
  })
  return doc
}

export const Proxies: CollectionConfig = {
  slug: 'proxies',
  // `Proxy` would shadow the global constructor in modules importing the generated type.
  typescript: { interface: 'MonitorProxy' },
  admin: {
    useAsTitle: 'host',
    group: 'Monitoring',
    defaultColumns: ['protocol', 'host', 'port', 'active', 'default'],
  },
  // Members read (to pick a proxy for their monitors, password stripped), admins write.
  access: {
    read: orgScoped('proxy:read'),
    create: orgScoped('proxy:create'),
    update: orgScoped('proxy:update'),
    delete: orgScoped('proxy:delete'),
  },
  indexes: [{ fields: ['organization', 'default'] }],
  hooks: {
    beforeValidate: [normalize],
    afterChange: [keepSingleDefault],
    beforeDelete: [detachMonitorRelation('proxy')],
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
        {
          name: 'protocol',
          type: 'select',
          required: true,
          defaultValue: 'https',
          options: PROXY_PROTOCOLS.map((value) => ({ label: value.toUpperCase(), value })),
        },
        { name: 'host', type: 'text', required: true, maxLength: 253 },
        { name: 'port', type: 'number', required: true, min: 1, max: 65535 },
      ],
    },
    {
      name: 'auth',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: 'The proxy requires a username and password.' },
    },
    {
      type: 'row',
      admin: { condition: (data) => Boolean(data?.auth) },
      fields: [
        { name: 'username', type: 'text', maxLength: 500 },
        {
          name: 'password',
          type: 'text',
          maxLength: 500,
          access: { read: secretReadAccess('proxy:update') },
          admin: { description: 'Only visible to users who may edit proxies.' },
        },
      ],
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        position: 'sidebar',
        description: 'Inactive proxies are ignored: monitors connect directly.',
      },
    },
    {
      name: 'default',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: {
        position: 'sidebar',
        description: 'Preselected for new HTTP monitors. One per organization.',
      },
    },
  ],
  timestamps: true,
}
