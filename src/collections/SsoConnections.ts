import type { CollectionBeforeChangeHook, CollectionConfig, FieldAccess } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { ROLES } from '@/access/permissions'
import { decryptSecret, encryptSecret } from '@/auth/two-factor/crypto'
import { env } from '@/env'
import { adminGroup, adminT } from '@/i18n/admin'

export const SSO_CONNECTIONS_SLUG = 'sso-connections' as const
export const SSO_CONNECTION_TYPES = ['oidc', 'saml'] as const
export type SsoConnectionType = (typeof SSO_CONNECTION_TYPES)[number]

/** Slugs reserved for the instance-wide providers (`src/auth/sso/providers.ts`) and route words. */
export const RESERVED_CONNECTION_SLUGS: ReadonlySet<string> = new Set([
  'oidc',
  'github',
  'google',
  'microsoft',
  'gitlab',
  'discord',
  'logout',
  'lookup',
  'providers',
  'connections',
])

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/

export function validateConnectionSlug(value: unknown): true | string {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) {
    return 'Use 2–64 lowercase letters, numbers and hyphens.'
  }
  if (RESERVED_CONNECTION_SLUGS.has(value)) return `"${value}" is reserved.`
  return true
}

/** Written by the server only; never readable through the API. */
const serverOnly: FieldAccess = () => false

/** Key scope for client secrets at rest (`src/auth/two-factor/crypto.ts`). */
const SECRET_PURPOSE = 'marmot:sso-client-secret'
const SEALED_PREFIX = 'v1.'

/** Seals a plaintext client secret; already-sealed values pass through. */
export const sealClientSecret = (value: string): string =>
  value.startsWith(SEALED_PREFIX) ? value : encryptSecret(value, env.PAYLOAD_SECRET, SECRET_PURPOSE)

/** The plaintext client secret of a connection, or `null` when unset or sealed with another key. */
export const openClientSecret = (sealed: string | null | undefined): string | null =>
  decryptSecret(sealed, env.PAYLOAD_SECRET, SECRET_PURPOSE)

const sealSecrets: CollectionBeforeChangeHook = ({ data }) => {
  if (typeof data.clientSecret === 'string' && data.clientSecret) {
    data.clientSecret = sealClientSecret(data.clientSecret)
  }
  if (typeof data.slug === 'string') data.slug = data.slug.trim().toLowerCase()
  return data
}

/**
 * Per-organization single sign-on connections (Settings → Security; `sso:read` to see,
 * `sso:manage` to change). Each connection is one identity provider, OpenID Connect or SAML 2.0,
 * reached at `/api/auth/sso/<slug>/…` (OIDC) or `/api/auth/saml/<slug>/…` (SAML); the login page
 * routes users to it by verified email domain (`sso-domains`) or organization slug. Users who sign
 * in through a connection are provisioned (when `autoProvision` is on) and join the organization
 * with `defaultRole`.
 *
 * The OIDC client secret is sealed at rest with a key derived from `PAYLOAD_SECRET` and is never
 * readable through the API; the login flow opens it server-side.
 */
export const SsoConnections: CollectionConfig = {
  slug: SSO_CONNECTIONS_SLUG,
  admin: {
    useAsTitle: 'name',
    group: adminGroup('access'),
    defaultColumns: ['name', 'slug', 'type', 'organization', 'enabled'],
  },
  access: {
    read: orgScoped('sso:read'),
    create: orgScoped('sso:manage'),
    update: orgScoped('sso:manage'),
    delete: orgScoped('sso:manage'),
  },
  hooks: {
    beforeChange: [sealSecrets],
  },
  indexes: [{ fields: ['organization', 'enabled'] }],
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
      name: 'name',
      type: 'text',
      required: true,
      admin: { description: adminT('marmot:ssoConnections:nameDescription') },
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: (value: unknown) => validateConnectionSlug(value),
      admin: { description: adminT('marmot:ssoConnections:slugDescription') },
    },
    {
      name: 'type',
      type: 'select',
      required: true,
      defaultValue: 'oidc',
      options: [
        { label: 'OpenID Connect', value: 'oidc' },
        { label: 'SAML 2.0', value: 'saml' },
      ],
    },
    {
      name: 'enabled',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:ssoConnections:enabledDescription'),
      },
    },
    // OpenID Connect
    {
      name: 'issuerUrl',
      type: 'text',
      admin: {
        condition: (data) => data?.type === 'oidc',
        description: adminT('marmot:ssoConnections:issuerUrlDescription'),
      },
    },
    { name: 'clientId', type: 'text', admin: { condition: (data) => data?.type === 'oidc' } },
    {
      name: 'clientSecret',
      type: 'text',
      access: { read: serverOnly },
      admin: {
        condition: (data) => data?.type === 'oidc',
        description: adminT('marmot:ssoConnections:clientSecretDescription'),
      },
    },
    {
      name: 'scopes',
      type: 'text',
      defaultValue: 'openid email profile',
      admin: { condition: (data) => data?.type === 'oidc' },
    },
    // SAML 2.0
    {
      name: 'idpEntryPoint',
      type: 'text',
      admin: {
        condition: (data) => data?.type === 'saml',
        description: adminT('marmot:ssoConnections:idpEntryPointDescription'),
      },
    },
    {
      name: 'idpEntityId',
      type: 'text',
      admin: {
        condition: (data) => data?.type === 'saml',
        description: adminT('marmot:ssoConnections:idpEntityIdDescription'),
      },
    },
    {
      name: 'idpCert',
      type: 'textarea',
      admin: {
        condition: (data) => data?.type === 'saml',
        description: adminT('marmot:ssoConnections:idpCertDescription'),
      },
    },
    {
      name: 'wantAssertionsSigned',
      type: 'checkbox',
      defaultValue: true,
      admin: { condition: (data) => data?.type === 'saml' },
    },
    {
      name: 'allowIdpInitiated',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        condition: (data) => data?.type === 'saml',
        description: adminT('marmot:ssoConnections:allowIdpInitiatedDescription'),
      },
    },
    // Provisioning
    {
      name: 'autoProvision',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:ssoConnections:autoProvisionDescription'),
      },
    },
    {
      name: 'defaultRole',
      type: 'select',
      defaultValue: 'member',
      options: ROLES.filter((role) => role !== 'owner').map((role) => ({
        label: role,
        value: role,
      })),
      admin: {
        position: 'sidebar',
        description: adminT('marmot:ssoConnections:defaultRoleDescription'),
      },
    },
  ],
  timestamps: true,
}
