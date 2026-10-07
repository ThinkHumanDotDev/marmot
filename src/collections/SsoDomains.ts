import crypto from 'node:crypto'

import type { CollectionBeforeValidateHook, CollectionConfig, FieldAccess } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminT } from '@/i18n/admin'

export const SSO_DOMAINS_SLUG = 'sso-domains' as const

/** DNS label under the domain that carries the verification TXT record. */
export const SSO_VERIFICATION_LABEL = '_marmot-verification'
export const SSO_VERIFICATION_PREFIX = 'marmot-verification='

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.$/, '')

export function validateDomain(value: unknown): true | string {
  if (typeof value !== 'string' || !DOMAIN_PATTERN.test(normalizeDomain(value))) {
    return 'Enter a domain name such as example.com.'
  }
  return true
}

export const generateVerificationToken = (): string => crypto.randomBytes(16).toString('hex')

/** Only managers see the token (they need it for the DNS record); nobody writes it. */
const managerRead: FieldAccess = ({ req, doc }) => {
  const org = (doc as { organization?: unknown } | undefined)?.organization
  const orgId = org && typeof org === 'object' ? (org as { id?: unknown }).id : org
  if (!req.user || orgId === undefined || orgId === null) return false
  // `orgScoped` is collection-level; a field access only gets a boolean, so re-check the role.
  return Boolean(req.user.superadmin) || hasManageRole(req.user, orgId)
}

const hasManageRole = (user: unknown, orgId: unknown): boolean => {
  const rows = (user as { organizations?: { organization: unknown; role?: string }[] })
    .organizations
  if (!Array.isArray(rows)) return false
  return rows.some((row) => {
    const id =
      row.organization && typeof row.organization === 'object'
        ? (row.organization as { id?: unknown }).id
        : row.organization
    return String(id) === String(orgId) && row.role === 'owner'
  })
}

const prepare: CollectionBeforeValidateHook = ({ data, operation }) => {
  if (!data) return data
  if (typeof data.domain === 'string') data.domain = normalizeDomain(data.domain)
  if (operation === 'create') {
    data.verificationToken = generateVerificationToken()
    data.verifiedAt = null
  }
  return data
}

/**
 * Email domains an organization has proven to own (a DNS TXT record
 * `_marmot-verification.<domain>` carrying `marmot-verification=<token>`). The login page routes
 * an email on a verified domain to that organization's SSO connections; a domain belongs to one
 * organization only (unique index). Verification is performed by
 * `POST /api/orgs/:orgId/sso/domains/:id/verify` (`src/server/sso/domains.ts`).
 */
export const SsoDomains: CollectionConfig = {
  slug: SSO_DOMAINS_SLUG,
  admin: {
    useAsTitle: 'domain',
    group: 'Access',
    defaultColumns: ['domain', 'organization', 'verifiedAt'],
  },
  access: {
    read: orgScoped('sso:read'),
    create: orgScoped('sso:manage'),
    update: orgScoped('sso:manage'),
    delete: orgScoped('sso:manage'),
  },
  hooks: {
    beforeValidate: [prepare],
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
      name: 'domain',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: (value: unknown) => validateDomain(value),
    },
    {
      name: 'verificationToken',
      type: 'text',
      required: true,
      access: { read: managerRead, create: () => false, update: () => false },
      admin: {
        readOnly: true,
        description: adminT('marmot:ssoDomains:verificationTokenDescription'),
      },
    },
    {
      name: 'verifiedAt',
      type: 'date',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true, position: 'sidebar' },
    },
  ],
  timestamps: true,
}
