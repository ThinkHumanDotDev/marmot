import type { CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { AUDIT_ACTOR_TYPES } from '@/server/audit/actions'

/** Clients never write audit rows; `recordAuditEvent` does, server-side with `overrideAccess`. */
const serverOnly = () => false

/**
 * Append-only audit log: sign-ins and account security events, membership changes and every
 * change to an organization's resources (monitors, channels, status pages, maintenance, API keys …;
 * see `AUDIT_ACTIONS` in `src/server/audit/actions.ts` and the coverage list in
 * `src/collections/audit.ts`). Updates store the changed paths with redacted before/after values.
 *
 * Holders of `audit-log:read` (admins and owners by default) read the rows of their organizations;
 * rows without an organization (sign-ins, failed logins, instance settings) are visible to
 * superadmins only. Rows older than `AUDIT_LOG_RETENTION_DAYS` are pruned by the retention job.
 */
export const AuditLogs: CollectionConfig = {
  slug: 'audit-logs',
  admin: {
    useAsTitle: 'action',
    group: adminGroup('access'),
    defaultColumns: ['action', 'actorLabel', 'organization', 'target', 'ip', 'createdAt'],
    description: adminT('marmot:auditLogs:description'),
  },
  access: {
    read: orgScoped('audit-log:read'),
    create: serverOnly,
    update: serverOnly,
    delete: serverOnly,
  },
  indexes: [{ fields: ['organization', 'createdAt'] }, { fields: ['entityType', 'entityId'] }],
  fields: [
    {
      name: 'action',
      type: 'text',
      required: true,
      index: true,
      admin: { readOnly: true },
    },
    {
      name: 'actorType',
      type: 'select',
      options: AUDIT_ACTOR_TYPES.map((value) => ({ label: value, value })),
      // Always set by `recordAuditEvent`; rows from before this field derive it from `actor`.
      index: true,
      admin: { readOnly: true },
    },
    {
      // Users only; API keys and other actors are identified by `actorRef`.
      name: 'actor',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      admin: { readOnly: true },
    },
    {
      // User or API key id as text (`actorId` in the API). Not `actorId`: on Postgres that column
      // name is taken by the `actor` relationship.
      name: 'actorRef',
      type: 'text',
      index: true,
      admin: { readOnly: true },
    },
    {
      name: 'actorLabel',
      type: 'text',
      admin: { readOnly: true, description: adminT('marmot:auditLogs:actorLabelDescription') },
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
      name: 'entityType',
      type: 'text',
      index: true,
      admin: { readOnly: true },
    },
    {
      name: 'entityId',
      type: 'text',
      admin: { readOnly: true },
    },
    {
      name: 'entityLabel',
      type: 'text',
      admin: { readOnly: true },
    },
    {
      name: 'changedFields',
      type: 'json',
      admin: { readOnly: true, description: adminT('marmot:auditLogs:changedFieldsDescription') },
    },
    {
      name: 'before',
      type: 'json',
      admin: { readOnly: true },
    },
    {
      name: 'after',
      type: 'json',
      admin: { readOnly: true },
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
