import { oidc, type OAuthProvider } from '@thinkhuman/payload-plugin-auth/oauth'
import type { SamlConnection } from '@thinkhuman/payload-plugin-auth/saml'
import type { Payload } from 'payload'

import type { OrgId, Role } from '@/access/permissions'
import { openClientSecret, SSO_CONNECTIONS_SLUG } from '@/collections/SsoConnections'
import { env } from '@/env'
import type { SsoConnection } from '@/payload-types'

const serverUrl = () => env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')

/** What a connection carries into the login hooks (`provider.meta`). */
export interface ConnectionMeta {
  connectionId: SsoConnection['id']
  organization: OrgId
  autoProvision: boolean
  defaultRole: Role
}

export const isConnectionMeta = (meta: unknown): meta is ConnectionMeta =>
  !!meta && typeof meta === 'object' && 'connectionId' in meta && 'organization' in meta

export const orgIdOf = (connection: SsoConnection): OrgId =>
  typeof connection.organization === 'object' ? connection.organization.id : connection.organization

/** `provider.meta` is an open record; the guard above narrows it back to `ConnectionMeta`. */
const metaOf = (connection: SsoConnection): Record<string, unknown> => {
  const meta: ConnectionMeta = {
    connectionId: connection.id,
    organization: orgIdOf(connection),
    autoProvision: connection.autoProvision !== false,
    defaultRole: (connection.defaultRole ?? 'member') as Role,
  }
  return { ...meta }
}

/** Paths of a connection's endpoints (relative to the server URL). */
export function connectionPaths(connection: Pick<SsoConnection, 'slug' | 'type'>) {
  const base =
    connection.type === 'saml'
      ? `/api/auth/saml/${connection.slug}`
      : `/api/auth/sso/${connection.slug}`
  return {
    loginPath: `${base}/login`,
    callbackPath: connection.type === 'saml' ? `${base}/acs` : `${base}/callback`,
    metadataPath: connection.type === 'saml' ? `${base}/metadata` : null,
  }
}

/** URLs an administrator registers at the identity provider. */
export function connectionEndpoints(connection: Pick<SsoConnection, 'slug' | 'type'>) {
  const paths = connectionPaths(connection)
  return {
    loginUrl: `${serverUrl()}${paths.loginPath}`,
    callbackUrl: `${serverUrl()}${paths.callbackPath}`,
    metadataUrl: paths.metadataPath ? `${serverUrl()}${paths.metadataPath}` : null,
    /** SAML service-provider entity id (= the metadata URL). */
    entityId: paths.metadataPath ? `${serverUrl()}${paths.metadataPath}` : null,
  }
}

/** Enabled connection with that slug, or `null`. Server-side (`overrideAccess`): the login flow has no user yet. */
export async function findEnabledConnection(
  payload: Payload,
  slug: string,
): Promise<SsoConnection | null> {
  if (!slug) return null
  const { docs } = await payload.find({
    collection: SSO_CONNECTIONS_SLUG,
    where: { and: [{ slug: { equals: slug.toLowerCase() } }, { enabled: { equals: true } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return docs[0] ?? null
}

/** Enabled connections of an organization, for the SSO login page. */
export async function listEnabledConnections(
  payload: Payload,
  orgId: OrgId,
): Promise<SsoConnection[]> {
  const { docs } = await payload.find({
    collection: SSO_CONNECTIONS_SLUG,
    where: { and: [{ organization: { equals: orgId } }, { enabled: { equals: true } }] },
    sort: 'name',
    limit: 50,
    depth: 0,
    overrideAccess: true,
  })
  return docs
}

/** `true` when any organization has an enabled connection (whether to show "Sign in with SSO"). */
export async function hasAnyEnabledConnection(payload: Payload): Promise<boolean> {
  const { totalDocs } = await payload.count({
    collection: SSO_CONNECTIONS_SLUG,
    where: { enabled: { equals: true } },
    overrideAccess: true,
  })
  return totalDocs > 0
}

/** The plugin's OAuth provider for an OIDC connection; `null` when it is incomplete. */
export function toOAuthProvider(connection: SsoConnection): OAuthProvider | null {
  if (connection.type !== 'oidc') return null
  const clientSecret = openClientSecret(connection.clientSecret)
  if (!connection.issuerUrl || !connection.clientId || !clientSecret) return null
  return oidc({
    id: connection.slug,
    name: connection.name,
    issuer: connection.issuerUrl,
    clientId: connection.clientId,
    clientSecret,
    scopes: (connection.scopes || 'openid email profile').split(/\s+/).filter(Boolean),
    icon: 'key',
    meta: metaOf(connection),
  })
}

/** The plugin's SAML connection for a SAML connection; `null` when it is incomplete. */
export function toSamlConnection(connection: SsoConnection): SamlConnection | null {
  if (connection.type !== 'saml') return null
  if (!connection.idpEntryPoint || !connection.idpCert) return null
  const endpoints = connectionEndpoints(connection)
  return {
    id: connection.slug,
    name: connection.name,
    entryPoint: connection.idpEntryPoint,
    idpCert: connection.idpCert,
    idpIssuer: connection.idpEntityId || undefined,
    entityId: endpoints.entityId ?? undefined,
    wantAssertionsSigned: connection.wantAssertionsSigned !== false,
    allowIdpInitiated: connection.allowIdpInitiated === true,
    icon: 'key',
    meta: metaOf(connection),
  }
}

/** A connection as Settings → Security shows it: never the client secret, plus the endpoints. */
export interface SsoConnectionRow {
  id: SsoConnection['id']
  name: string
  slug: string
  type: SsoConnection['type']
  enabled: boolean
  issuerUrl: string | null
  clientId: string | null
  hasClientSecret: boolean
  scopes: string | null
  idpEntryPoint: string | null
  idpEntityId: string | null
  idpCert: string | null
  wantAssertionsSigned: boolean
  allowIdpInitiated: boolean
  autoProvision: boolean
  defaultRole: Role
  loginUrl: string
  callbackUrl: string
  metadataUrl: string | null
  entityId: string | null
  createdAt: string
}

export function toConnectionRow(connection: SsoConnection): SsoConnectionRow {
  const endpoints = connectionEndpoints(connection)
  return {
    id: connection.id,
    name: connection.name,
    slug: connection.slug,
    type: connection.type,
    enabled: connection.enabled !== false,
    issuerUrl: connection.issuerUrl ?? null,
    clientId: connection.clientId ?? null,
    hasClientSecret: Boolean(connection.clientSecret),
    scopes: connection.scopes ?? null,
    idpEntryPoint: connection.idpEntryPoint ?? null,
    idpEntityId: connection.idpEntityId ?? null,
    idpCert: connection.idpCert ?? null,
    wantAssertionsSigned: connection.wantAssertionsSigned !== false,
    allowIdpInitiated: connection.allowIdpInitiated === true,
    autoProvision: connection.autoProvision !== false,
    defaultRole: (connection.defaultRole ?? 'member') as Role,
    ...endpoints,
    createdAt: connection.createdAt,
  }
}
