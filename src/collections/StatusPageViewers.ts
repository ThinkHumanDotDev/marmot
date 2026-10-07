import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'

export const STATUS_PAGE_VIEWER_STATUSES = ['active', 'revoked'] as const
export type StatusPageViewerStatus = (typeof STATUS_PAGE_VIEWER_STATUSES)[number]

const never = () => false

/**
 * Visitors of `email-domain` status pages who signed in through a magic link: one row per page and
 * address, created by the link (`src/server/status-pages/magic-link.ts`, `overrideAccess`). Their
 * access cookie names the row, so revoking it (`status: 'revoked'`) signs the visitor out at once
 * and refuses new links to that address; deleting it only forgets the visitor, who may sign in
 * again while their domain is allowed.
 *
 * Members with `status-page:read` list them; `status-page:update` revokes, restores and deletes.
 */
export const StatusPageViewers: CollectionConfig = {
  slug: 'status-page-viewers',
  admin: {
    useAsTitle: 'email',
    group: adminGroup('statusPages'),
    defaultColumns: ['email', 'page', 'status', 'lastSeenAt'],
  },
  access: {
    read: orgScoped('status-page:read'),
    create: never,
    update: orgScoped('status-page:update'),
    delete: orgScoped('status-page:update'),
  },
  indexes: [{ fields: ['page', 'email'], unique: true }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      access: { update: never },
      admin: { position: 'sidebar', readOnly: true },
    },
    {
      name: 'page',
      type: 'relationship',
      relationTo: 'status-pages',
      required: true,
      index: true,
      access: { update: never },
      admin: { readOnly: true },
    },
    {
      name: 'email',
      type: 'email',
      required: true,
      access: { update: never },
      admin: { readOnly: true },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'active',
      options: STATUS_PAGE_VIEWER_STATUSES.map((status) => ({ label: status, value: status })),
      admin: { description: adminT('marmot:statusPageViewers:statusDescription') },
    },
    {
      name: 'lastSeenAt',
      type: 'date',
      access: { update: never },
      admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } },
    },
  ],
  timestamps: true,
}
