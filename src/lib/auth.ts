import 'server-only'

import { headers as getHeaders } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload, type Payload } from 'payload'
import { cache } from 'react'

import config from '@payload-config'
import type { User } from '@/payload-types'
import { isUnverified, needsEmailVerification } from '@/server/auth/email-verification'

/** One organization the current user belongs to, as the UI needs it. */
export interface OrgMembership {
  id: string | number
  slug: string
  name: string
  role?: string
}

/** The authenticated Payload user, including organization memberships. */
export type CurrentUser = User

/**
 * Resolves the Payload user for the current request (cookie or Authorization header).
 * Memoised per request with React `cache` so layouts and pages share one lookup.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await getHeaders() })
  return (user as CurrentUser | null) ?? null
})

/**
 * Redirects to `/login` (remembering where the user wanted to go) when signed out, and to the
 * "check your inbox" screen (`/verify-email`) while the account still has to confirm its address
 * (#177, `needsEmailVerification`).
 */
export async function requireUser(next?: string): Promise<CurrentUser> {
  const user = await getCurrentUser()
  const search = next ? `?next=${encodeURIComponent(next)}` : ''
  if (!user) redirect(`/login${search}`)
  if (isUnverified(user) && (await needsEmailVerification(await getPayload({ config }), user))) {
    redirect(`/verify-email${search}`)
  }
  return user
}

interface MembershipRow {
  organization?: unknown
  role?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Normalises the user's `organizations` array (rows look like
 * `{ organization: { id, slug, name } | id, role }`). Rows whose organization is only an id are
 * resolved through the Local API when the `organizations` collection exists; otherwise skipped.
 */
export async function getUserOrganizations(
  user: CurrentUser | null,
  payload?: Payload,
): Promise<OrgMembership[]> {
  if (!user || !Array.isArray(user.organizations)) return []

  const memberships: OrgMembership[] = []
  const unresolved: { id: string | number; role?: string }[] = []

  for (const raw of user.organizations as unknown[]) {
    if (!isRecord(raw)) continue
    const row = raw as MembershipRow
    const role = typeof row.role === 'string' ? row.role : undefined
    const org = row.organization
    if (isRecord(org) && typeof org.slug === 'string' && org.id !== undefined) {
      memberships.push({
        id: org.id as string | number,
        slug: org.slug,
        name: typeof org.name === 'string' ? org.name : org.slug,
        role,
      })
    } else if (typeof org === 'string' || typeof org === 'number') {
      unresolved.push({ id: org, role })
    }
  }

  if (unresolved.length > 0) {
    const client = payload ?? (await getPayload({ config }))
    if ('organizations' in client.collections) {
      try {
        const { docs } = await client.find({
          // The collection is registered by the multi-tenant issue; cast until types catch up.
          collection: 'organizations' as never,
          where: { id: { in: unresolved.map((u) => u.id) } },
          limit: unresolved.length,
          depth: 0,
          overrideAccess: true,
        })
        for (const doc of docs as unknown[]) {
          if (!isRecord(doc) || typeof doc.slug !== 'string') continue
          const match = unresolved.find((u) => String(u.id) === String(doc.id))
          memberships.push({
            id: doc.id as string | number,
            slug: doc.slug,
            name: typeof doc.name === 'string' ? doc.name : doc.slug,
            role: match?.role,
          })
        }
      } catch {
        // Organizations are optional at this stage of the project; fall through with what we have.
      }
    }
  }

  return memberships
}

/** Where a signed-in user lands: their first organization, or onboarding when they have none. */
export function homePathFor(organizations: OrgMembership[]): string {
  return organizations[0] ? `/${organizations[0].slug}` : '/onboarding'
}
