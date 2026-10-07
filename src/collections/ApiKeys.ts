import type { CollectionConfig, FieldAccess } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { API_KEY_SCOPES } from '@/lib/api-key-scopes'

/**
 * Organization API keys (`api-key:*` permissions, admin and owner only). A key authenticates
 * machine clients — Prometheus scraping `/api/metrics`, badge embeds of monitors that are not on a
 * public status page, and the management API under `/api/orgs/:orgId/**` — as the organization it
 * belongs to, never as a user. `scope` is fixed at creation: `read` keys act as a `viewer` and may
 * only send `GET` requests, `write` keys act as a `member` (`src/server/auth/request-auth.ts`).
 *
 * Only the SHA-256 of the plaintext key is stored; the plaintext is returned once by
 * `POST /api/orgs/:orgId/api-keys` (`src/server/api-keys`). `prefix` is the short public part the
 * UI shows so people can tell keys apart.
 *
 * Modelled on Uptime Kuma 2.5.5 `server/model/api_key.js` (MIT, Louis Lam).
 */

/** Written by the server only (`overrideAccess: true` bypasses field access). */
const serverOnly: FieldAccess = () => false

export const ApiKeys: CollectionConfig = {
  slug: 'api-keys',
  admin: {
    useAsTitle: 'name',
    group: adminGroup('access'),
    defaultColumns: [
      'name',
      'prefix',
      'scope',
      'organization',
      'active',
      'expiresAt',
      'lastUsedAt',
    ],
  },
  access: {
    read: orgScoped('api-key:read'),
    create: orgScoped('api-key:create'),
    update: orgScoped('api-key:delete'),
    delete: orgScoped('api-key:delete'),
  },
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
    { name: 'name', type: 'text', required: true },
    {
      name: 'keyHash',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      access: { read: serverOnly, create: serverOnly, update: serverOnly },
      admin: { hidden: true, description: adminT('marmot:apiKeys:keyHashDescription') },
    },
    {
      name: 'prefix',
      type: 'text',
      required: true,
      index: true,
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, description: adminT('marmot:apiKeys:prefixDescription') },
    },
    {
      // Immutable: a key's power never changes after the plaintext was handed out. Existing keys
      // (created before scopes existed) are `read`.
      name: 'scope',
      type: 'select',
      required: true,
      defaultValue: 'read',
      options: [...API_KEY_SCOPES],
      index: true,
      access: { update: serverOnly },
      admin: { position: 'sidebar', description: adminT('marmot:apiKeys:scopeDescription') },
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      admin: { position: 'sidebar', description: adminT('marmot:apiKeys:activeDescription') },
    },
    {
      name: 'expiresAt',
      type: 'date',
      admin: {
        position: 'sidebar',
        date: { pickerAppearance: 'dayAndTime' },
        description: adminT('marmot:apiKeys:expiresAtDescription'),
      },
    },
    {
      name: 'lastUsedAt',
      type: 'date',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } },
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
