import dns from 'node:dns/promises'

import type { Payload } from 'payload'

import type { OrgId } from '@/access/permissions'
import {
  normalizeDomain,
  SSO_DOMAINS_SLUG,
  SSO_VERIFICATION_LABEL,
  SSO_VERIFICATION_PREFIX,
} from '@/collections/SsoDomains'
import type { Organization, SsoDomain } from '@/payload-types'

import { connectionPaths, listEnabledConnections } from './connections'

export type TxtResolver = (hostname: string) => Promise<string[][]>

/** DNS record an organization adds to prove it owns a domain. */
export function verificationRecord(domain: SsoDomain) {
  return {
    name: `${SSO_VERIFICATION_LABEL}.${domain.domain}`,
    type: 'TXT' as const,
    value: `${SSO_VERIFICATION_PREFIX}${domain.verificationToken}`,
  }
}

export interface VerificationResult {
  verified: boolean
  /** Why the lookup did not verify (for the UI); `undefined` when verified. */
  reason?: string
}

/**
 * Looks up `_marmot-verification.<domain>` and marks the domain verified when one TXT record
 * carries the expected token. `resolveTxt` is injectable for tests; DNS failures (NXDOMAIN, no
 * network) are reported, never thrown.
 */
export async function verifyDomain(
  payload: Payload,
  domain: SsoDomain,
  resolveTxt: TxtResolver = (hostname) => dns.resolveTxt(hostname),
): Promise<VerificationResult> {
  const record = verificationRecord(domain)
  let records: string[][]
  try {
    records = await resolveTxt(record.name)
  } catch (error) {
    const code = (error as { code?: string }).code
    return {
      verified: false,
      reason:
        code === 'ENOTFOUND' || code === 'ENODATA'
          ? `No TXT record found at ${record.name} yet. DNS changes can take a few minutes to propagate.`
          : `DNS lookup of ${record.name} failed (${code ?? 'unknown error'}).`,
    }
  }
  const values = records.map((chunks) => chunks.join('').trim())
  if (!values.includes(record.value)) {
    return {
      verified: false,
      reason: `${record.name} exists but none of its values is ${record.value}.`,
    }
  }
  await payload.update({
    collection: SSO_DOMAINS_SLUG,
    id: domain.id,
    data: { verifiedAt: new Date().toISOString() },
    depth: 0,
    overrideAccess: true,
  })
  return { verified: true }
}

/** The email's domain part, normalised; `null` when the address is malformed. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return null
  const domain = normalizeDomain(email.slice(at + 1))
  return domain.includes('.') ? domain : null
}

/** A connection the public SSO page can show: no secrets, just where to start. */
export interface SsoLoginOption {
  id: string
  name: string
  type: 'oidc' | 'saml'
  loginPath: string
  organization: { name: string; slug: string }
}

async function optionsFor(payload: Payload, org: Organization): Promise<SsoLoginOption[]> {
  const connections = await listEnabledConnections(payload, org.id)
  return connections.map((connection) => ({
    id: connection.slug,
    name: connection.name,
    type: connection.type,
    loginPath: connectionPaths(connection).loginPath,
    organization: { name: org.name, slug: org.slug },
  }))
}

async function orgById(payload: Payload, id: OrgId): Promise<Organization | null> {
  try {
    return await payload.findByID({
      collection: 'organizations',
      id,
      depth: 0,
      overrideAccess: true,
    })
  } catch {
    return null
  }
}

/** Connections of the organization that verified the email's domain; `[]` when there is none. */
export async function lookupSsoForEmail(
  payload: Payload,
  email: string,
): Promise<SsoLoginOption[]> {
  const domain = emailDomain(email)
  if (!domain) return []
  const { docs } = await payload.find({
    collection: SSO_DOMAINS_SLUG,
    where: { and: [{ domain: { equals: domain } }, { verifiedAt: { exists: true } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const verified = docs[0]
  if (!verified) return []
  const orgId =
    typeof verified.organization === 'object' ? verified.organization.id : verified.organization
  const org = await orgById(payload, orgId)
  return org ? optionsFor(payload, org) : []
}

/** Connections of the organization with that slug; `[]` when it does not exist or has none. */
export async function lookupSsoForOrg(payload: Payload, slug: string): Promise<SsoLoginOption[]> {
  const { docs } = await payload.find({
    collection: 'organizations',
    where: { slug: { equals: slug.trim().toLowerCase() } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const org = docs[0]
  return org ? optionsFor(payload, org) : []
}

/** Whether `email` belongs to a domain `orgId` has verified (the organization vouches for it). */
export async function isVerifiedDomainOf(
  payload: Payload,
  orgId: OrgId,
  email: string | undefined,
): Promise<boolean> {
  const domain = email ? emailDomain(email) : null
  if (!domain) return false
  const { totalDocs } = await payload.count({
    collection: SSO_DOMAINS_SLUG,
    where: {
      and: [
        { domain: { equals: domain } },
        { organization: { equals: orgId } },
        { verifiedAt: { exists: true } },
      ],
    },
    overrideAccess: true,
  })
  return totalDocs > 0
}
