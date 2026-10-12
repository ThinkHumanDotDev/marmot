import {
  ValidationError,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type FieldAccess,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import {
  DEFAULT_SSH_PORT,
  normalizeHostFingerprint,
  SSH_TUNNEL_AUTH_METHODS,
} from '@/lib/ssh-tunnels'
import type { SshTunnel } from '@/payload-types'
import { userErrorText } from '@/server/request-locale'
import { literalTargetDenial } from '@/server/security/outbound-guard'
import { privateKeyProblem } from '@/server/ssh-tunnels/connection'
import {
  isSealedTunnelSecret,
  openTunnelSecret,
  sealTunnelSecret,
  SSH_TUNNEL_SECRET_FIELDS,
} from '@/server/ssh-tunnels/secrets'

import { detachMonitorRelation } from './shared'

/** Credentials are written through the API but never read back, not even by admins. */
const writeOnly: FieldAccess = () => false

type TunnelData = Partial<SshTunnel>

/** The plaintext of a credential after this change: new input, else the stored (sealed) value. */
const plainAfter = (
  field: (typeof SSH_TUNNEL_SECRET_FIELDS)[number],
  data: TunnelData,
  originalDoc: SshTunnel | undefined,
): string | null => {
  const value = data[field]
  if (typeof value === 'string' && value) {
    return isSealedTunnelSecret(value) ? openTunnelSecret(value) : value
  }
  if (value === null) return null
  return openTunnelSecret(originalDoc?.[field])
}

/**
 * Trim the connection fields, canonicalise the host key fingerprint, keep only the credentials of
 * the chosen method and check they are complete (a private key must parse, with its passphrase).
 * An empty credential in the input keeps the stored one, so forms never need to know it.
 */
const validateTunnel: CollectionBeforeValidateHook<SshTunnel> = ({ data, originalDoc, req }) => {
  if (!data) return data
  const fail = (path: string, message: string): never => {
    throw new ValidationError({ collection: 'ssh-tunnels', errors: [{ message, path }] })
  }
  for (const field of ['name', 'host', 'username'] as const) {
    if (typeof data[field] === 'string') data[field] = data[field].trim()
  }
  if (typeof data.host === 'string') {
    // Outbound address guard: fast feedback for a literally denied bastion address (names are
    // vetted when the worker connects).
    const denial = literalTargetDenial(data.host)
    if (denial) fail('host', denial)
  }
  if (data.knownHostFingerprint !== undefined) {
    const fingerprint = normalizeHostFingerprint(data.knownHostFingerprint)
    if (!fingerprint) {
      return fail('knownHostFingerprint', userErrorText(req, 'sshFingerprintInvalid'))
    }
    data.knownHostFingerprint = fingerprint
  }

  for (const field of SSH_TUNNEL_SECRET_FIELDS) {
    if (data[field] === '') delete data[field]
  }
  const authMethod = data.authMethod ?? originalDoc?.authMethod ?? 'password'
  if (authMethod === 'password') {
    data.privateKey = null
    data.passphrase = null
    if (!plainAfter('password', data, originalDoc)) {
      fail('password', userErrorText(req, 'sshPasswordRequired'))
    }
  } else {
    data.password = null
    const key = plainAfter('privateKey', data, originalDoc)
    if (!key) fail('privateKey', userErrorText(req, 'sshPrivateKeyRequired'))
    const keyChanged = typeof data.privateKey === 'string' || data.passphrase !== undefined
    if (key && keyChanged) {
      const problem = privateKeyProblem(key, plainAfter('passphrase', data, originalDoc))
      if (problem) fail('privateKey', userErrorText(req, 'sshPrivateKeyInvalid', { problem }))
    }
  }
  return data
}

/** Seal new credentials and record which ones are set (the only thing clients learn about them). */
const sealCredentials: CollectionBeforeChangeHook<SshTunnel> = ({ data, originalDoc }) => {
  for (const field of SSH_TUNNEL_SECRET_FIELDS) {
    const value = data[field]
    if (typeof value === 'string' && value && !isSealedTunnelSecret(value)) {
      data[field] = sealTunnelSecret(value)
    }
  }
  const isSet = (field: (typeof SSH_TUNNEL_SECRET_FIELDS)[number]) =>
    Boolean(data[field] !== undefined ? data[field] : originalDoc?.[field])
  data.hasPassword = isSet('password')
  data.hasPrivateKey = isSet('privateKey')
  data.hasPassphrase = isSet('passphrase')
  return data
}

/**
 * SSH tunnels (#160): bastion hosts that monitors opening TCP connections (HTTP family, TCP port,
 * SQL databases, Redis, SMTP) reach internal targets through. The worker keeps one pooled SSH
 * connection per tunnel and forwards each check's connections with `forwardOut`
 * (`src/server/ssh-tunnels`).
 *
 * The password, private key and passphrase are sealed at rest with a key derived from
 * `PAYLOAD_SECRET` and are never readable through any API (`hasPassword`, `hasPrivateKey` and
 * `hasPassphrase` say whether they are set). The bastion's host key is pinned by its SHA-256
 * fingerprint and verified before authenticating.
 */
export const SshTunnels: CollectionConfig = {
  slug: 'ssh-tunnels',
  admin: {
    useAsTitle: 'name',
    group: adminGroup('monitoring'),
    defaultColumns: ['name', 'host', 'port', 'username'],
  },
  // Members read (to pick a tunnel for their monitors), admins write: a tunnel reaches a network.
  access: {
    read: orgScoped('ssh-tunnel:read'),
    create: orgScoped('ssh-tunnel:create'),
    update: orgScoped('ssh-tunnel:update'),
    delete: orgScoped('ssh-tunnel:delete'),
  },
  hooks: {
    beforeValidate: [validateTunnel],
    beforeChange: [sealCredentials],
    beforeDelete: [detachMonitorRelation('sshTunnel')],
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
    { name: 'name', type: 'text', required: true, maxLength: 150 },
    {
      type: 'row',
      fields: [
        { name: 'host', type: 'text', required: true, maxLength: 253 },
        {
          name: 'port',
          type: 'number',
          required: true,
          defaultValue: DEFAULT_SSH_PORT,
          min: 1,
          max: 65535,
        },
      ],
    },
    { name: 'username', type: 'text', required: true, maxLength: 255 },
    {
      name: 'authMethod',
      type: 'select',
      required: true,
      defaultValue: 'password',
      options: SSH_TUNNEL_AUTH_METHODS.map((value) => ({
        label: adminT(
          value === 'password'
            ? 'marmot:sshTunnels:authPassword'
            : 'marmot:sshTunnels:authPrivateKey',
        ),
        value,
      })),
    },
    {
      name: 'password',
      type: 'text',
      maxLength: 4096,
      access: { read: writeOnly },
      admin: {
        condition: (data) => data?.authMethod !== 'privateKey',
        description: adminT('marmot:sshTunnels:secretDescription'),
      },
    },
    {
      name: 'privateKey',
      type: 'textarea',
      maxLength: 65536,
      access: { read: writeOnly },
      admin: {
        condition: (data) => data?.authMethod === 'privateKey',
        description: adminT('marmot:sshTunnels:secretDescription'),
      },
    },
    {
      name: 'passphrase',
      type: 'text',
      maxLength: 4096,
      access: { read: writeOnly },
      admin: {
        condition: (data) => data?.authMethod === 'privateKey',
        description: adminT('marmot:sshTunnels:secretDescription'),
      },
    },
    {
      name: 'knownHostFingerprint',
      type: 'text',
      required: true,
      maxLength: 100,
      admin: {
        placeholder: 'SHA256:…',
        description: adminT('marmot:sshTunnels:fingerprintDescription'),
      },
    },
    {
      type: 'row',
      fields: [
        { name: 'hasPassword', type: 'checkbox', defaultValue: false, admin: { readOnly: true } },
        { name: 'hasPrivateKey', type: 'checkbox', defaultValue: false, admin: { readOnly: true } },
        { name: 'hasPassphrase', type: 'checkbox', defaultValue: false, admin: { readOnly: true } },
      ],
    },
  ],
  timestamps: true,
}
