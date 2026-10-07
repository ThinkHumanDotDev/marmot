import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'

/** Clients never write audit rows; `recordAuditEvent` does, server-side with `overrideAccess`. */
const serverOnly = () => false

/**
 * Append-only security log: logins, membership changes, invitations and organization changes
 * (see `AUDIT_ACTIONS` in `src/server/security/audit.ts`). Organization admins read the rows of
 * their organizations; rows without an organization (failed logins, rate limits) are visible to
 * superadmins only. Rows older than `AUDIT_LOG_KEEP_DAYS` are pruned by the retention job.
 */
export const AuditLogs: CollectionConfig = {
  slug: 'audit-logs',
  admin: {
    useAsTitle: 'action',
    group: adminGroup('access'),
    defaultColumns: ['action', 'actor', 'organization', 'target', 'ip', 'createdAt'],
    description: adminT('marmot:auditLogs:description'),
  },
  access: {
    read: orgScoped('audit-log:read'),
    create: serverOnly,
    update: serverOnly,
    delete: serverOnly,
  },
  fields: [
    {
      name: 'action',
      type: 'text',
      required: true,
      index: true,
      admin: { readOnly: true },
    },
    {
      name: 'actor',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      admin: { readOnly: true },
    },
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      index: true,
      admin: { readOnly: true },
    },
    {
      name: 'target',
      type: 'text',
      admin: { readOnly: true, description: adminT('marmot:auditLogs:targetDescription') },
    },
    {
      name: 'ip',
      type: 'text',
      admin: { readOnly: true },
    },
    {
      name: 'userAgent',
      type: 'text',
      admin: { readOnly: true },
    },
    {
      name: 'metadata',
      type: 'json',
      admin: { readOnly: true },
    },
  ],
  timestamps: true,
}
