import { getPayload } from 'payload'
import config from '@payload-config'

import type { Organization, User } from '@/payload-types'

export interface SeedUser {
  email: string
  password: string
  name: string
}

/** Creates (or recreates) a plain user for e2e tests. */
export async function seedUser(user: SeedUser): Promise<User> {
  const payload = await getPayload({ config })
  await payload.delete({ collection: 'users', where: { email: { equals: user.email } } })
  return payload.create({ collection: 'users', data: user })
}

/**
 * Creates an organization owned by `owner` (the `afterChange` hook grants the owner membership
 * when the request carries the creating user).
 */
export async function seedOrganization(
  owner: User,
  org: { name: string; slug: string },
): Promise<Organization> {
  const payload = await getPayload({ config })
  await payload.delete({ collection: 'organizations', where: { slug: { equals: org.slug } } })
  return payload.create({
    collection: 'organizations',
    data: org,
    user: { ...owner, collection: 'users' },
    overrideAccess: false,
  })
}

/** Token of the most recent pending invitation addressed to `email`. */
export async function findInvitationToken(email: string): Promise<string> {
  const payload = await getPayload({ config })
  const { docs } = await payload.find({
    collection: 'invitations',
    where: { and: [{ email: { equals: email } }, { status: { equals: 'pending' } }] },
    sort: '-createdAt',
    limit: 1,
    depth: 0,
  })
  const token = docs[0]?.token
  if (!token) throw new Error(`No pending invitation for ${email}`)
  return token
}

export async function cleanupOrganization(slug: string): Promise<void> {
  const payload = await getPayload({ config })
  await payload.delete({ collection: 'organizations', where: { slug: { equals: slug } } })
}

export async function cleanupUsers(emails: string[]): Promise<void> {
  const payload = await getPayload({ config })
  await payload.delete({ collection: 'users', where: { email: { in: emails } } })
}
