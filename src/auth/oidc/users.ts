import crypto from 'node:crypto'

import type { Payload } from 'payload'

import { acceptInvitation } from '@/collections/Invitations'
import { childLogger } from '@/lib/logger'

import { OidcLoginError } from './errors'

import type { Invitation, User } from '@/payload-types'

const log = childLogger('oidc')

/** The subset of ID token / UserInfo claims Marmot reads. */
export interface OidcClaims {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  given_name?: string
  family_name?: string
  nickname?: string
}

/** Narrows an arbitrary claims object to `OidcClaims`, dropping values of the wrong type. */
export function pickClaims(raw: Record<string, unknown>): OidcClaims {
  const str = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined)
  const sub = str('sub')
  if (!sub) throw new Error('claims are missing the sub claim')
  return {
    sub,
    email: str('email'),
    email_verified: raw.email_verified === true,
    name: str('name'),
    preferred_username: str('preferred_username'),
    given_name: str('given_name'),
    family_name: str('family_name'),
    nickname: str('nickname'),
  }
}

/** Human-friendly name for a new account: `name`, then given + family, then nickname/username. */
export function displayNameFromClaims(claims: OidcClaims): string | undefined {
  const full = claims.name?.trim()
  if (full) return full
  const composed = [claims.given_name, claims.family_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ')
  if (composed) return composed
  return claims.nickname?.trim() || claims.preferred_username?.trim() || undefined
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

/** SSO accounts still need a local password column; nobody ever learns this one. */
export const randomLocalPassword = (): string => crypto.randomBytes(32).toString('base64url')

export interface ResolveOidcUserArgs {
  payload: Payload
  /** Issuer identifier the claims came from (`iss`). */
  issuer: string
  claims: OidcClaims
  /** `OIDC_AUTO_PROVISION` */
  autoProvision: boolean
  /** `DISABLE_SIGNUP` */
  signupDisabled: boolean
}

async function findPendingInvitation(
  payload: Payload,
  email: string,
): Promise<Invitation | undefined> {
  const { docs } = await payload.find({
    collection: 'invitations',
    where: {
      and: [
        { email: { equals: email } },
        { status: { equals: 'pending' } },
        { expiresAt: { greater_than: new Date().toISOString() } },
      ],
    },
    sort: '-createdAt',
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return docs[0]
}

/**
 * Maps an authenticated OIDC identity to a Marmot user.
 *
 * 1. `(oidcIssuer, oidcSubject)` match → that user.
 * 2. Otherwise a user with the same email: linked (subject recorded) only when the provider
 *    asserts `email_verified`; an unverified email never takes over an existing account.
 * 3. Otherwise, when `OIDC_AUTO_PROVISION` is on, a new user is created with a random password.
 *    While `DISABLE_SIGNUP` is set this requires a pending invitation for the email, which is then
 *    accepted so the user lands in the inviting organization.
 *
 * Throws `OidcLoginError` with a code the callback redirects to `/login?error=` with.
 */
export async function resolveOidcUser({
  payload,
  issuer,
  claims,
  autoProvision,
  signupDisabled,
}: ResolveOidcUserArgs): Promise<User> {
  const bySubject = await payload.find({
    collection: 'users',
    where: {
      and: [{ oidcIssuer: { equals: issuer } }, { oidcSubject: { equals: claims.sub } }],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (bySubject.docs[0]) return bySubject.docs[0]

  const email = claims.email ? normalizeEmail(claims.email) : undefined
  if (!email) throw new OidcLoginError('email_missing')

  const byEmail = await payload.find({
    collection: 'users',
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const existing = byEmail.docs[0]
  if (existing) {
    if (!claims.email_verified) throw new OidcLoginError('email_unverified')
    log.info({ user: existing.id }, 'linking existing user to OIDC identity')
    return payload.update({
      collection: 'users',
      id: existing.id,
      data: { oidcIssuer: issuer, oidcSubject: claims.sub },
      depth: 0,
      overrideAccess: true,
    })
  }

  if (!autoProvision) throw new OidcLoginError('provisioning_disabled')

  const invitation = signupDisabled ? await findPendingInvitation(payload, email) : undefined
  if (signupDisabled && !invitation) throw new OidcLoginError('signup_disabled')

  const user = await payload.create({
    collection: 'users',
    data: {
      email,
      password: randomLocalPassword(),
      name: displayNameFromClaims(claims),
      authProvider: 'oidc',
      oidcIssuer: issuer,
      oidcSubject: claims.sub,
    },
    depth: 0,
    overrideAccess: true,
  })
  log.info({ user: user.id }, 'provisioned user from OIDC identity')

  if (invitation?.token) {
    try {
      await acceptInvitation({ payload, token: invitation.token, user })
    } catch (error) {
      // The account exists either way; the invitation link can still be used afterwards.
      log.warn({ err: error, user: user.id }, 'could not accept invitation during provisioning')
    }
  }

  return user
}
