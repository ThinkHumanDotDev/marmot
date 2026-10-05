import { createLocalReq, generatePayloadCookie, type Payload } from 'payload'
import { z } from 'zod'

import { validateOrganizationSlug } from '@/lib/reserved-slugs'
import type { Organization, User } from '@/payload-types'

/**
 * First-run setup (Uptime Kuma style): while the `users` collection is empty the instance
 * "needs setup" and `/` sends visitors to `/setup`, where the first superadmin and their
 * organization are created in one transaction.
 */

/**
 * Kept for API compatibility: `needsSetup` no longer caches. Next.js bundles server modules per
 * route, so a module-level flag would differ between the status route and the pages, and a
 * reset database (tests, restores) would be reported inconsistently.
 */
export function resetSetupCache(): void {}

/**
 * `true` while no user exists. This is one indexed count query per anonymous page load, which is
 * cheap enough that we deliberately do not cache it.
 */
export async function needsSetup(payload: Payload): Promise<boolean> {
  const { totalDocs } = await payload.count({ collection: 'users' })
  return totalDocs === 0
}

export const setupSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120),
  email: z.email('Enter a valid email address'),
  password: z.string().min(8, 'Use at least 8 characters').max(256),
  organizationName: z.string().trim().min(1, 'Enter an organization name').max(120),
  organizationSlug: z
    .string()
    .trim()
    .toLowerCase()
    .refine((slug) => validateOrganizationSlug(slug) === true, {
      error: (issue) => {
        const result = validateOrganizationSlug(issue.input)
        return typeof result === 'string' ? result : 'Invalid slug.'
      },
    }),
})

export type SetupInput = z.infer<typeof setupSchema>

/** Error with an HTTP status, thrown by `runSetup`. */
export class SetupError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'SetupError'
    this.status = status
  }
}

export interface SetupResult {
  user: User
  organization: Organization
}

/**
 * Creates the first superadmin and their organization atomically. The organization's
 * `afterChange` hook grants the creator the `owner` role because `req.user` is set to the new
 * user before the organization is created. Everything runs in one database transaction; any
 * failure (duplicate email, invalid slug, …) rolls back and leaves the instance untouched, so
 * `needsSetup()` stays `true`. Throws `SetupError(409)` when a user already exists.
 */
export async function runSetup(payload: Payload, input: SetupInput): Promise<SetupResult> {
  if (!(await needsSetup(payload))) {
    throw new SetupError('Setup has already been completed.', 409)
  }

  const slugCheck = validateOrganizationSlug(input.organizationSlug)
  if (slugCheck !== true) throw new SetupError(slugCheck, 400)

  const req = await createLocalReq({}, payload)
  // `null` when the adapter cannot run transactions (MongoDB without a replica set, SQLite with
  // transactions disabled); the user is then removed by hand if the organization step fails.
  const transactionID = await payload.db.beginTransaction()
  if (transactionID) req.transactionID = transactionID
  let createdUserId: User['id'] | undefined

  try {
    // Re-check inside the transaction so two concurrent submissions cannot both succeed.
    const { totalDocs } = await payload.count({ collection: 'users', req })
    if (totalDocs > 0) throw new SetupError('Setup has already been completed.', 409)

    const user = await payload.create({
      collection: 'users',
      data: {
        name: input.name,
        email: input.email,
        password: input.password,
        superadmin: true,
      },
      depth: 0,
      req,
    })
    createdUserId = user.id

    // The organizations `afterChange` hook makes `req.user` the owner.
    req.user = { ...user, collection: 'users' }

    const organization = await payload.create({
      collection: 'organizations',
      data: { name: input.organizationName, slug: input.organizationSlug },
      depth: 0,
      req,
    })

    if (transactionID) await payload.db.commitTransaction(transactionID)

    const freshUser = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
    return { user: freshUser, organization }
  } catch (error) {
    if (transactionID) {
      // Payload may already have rolled back from inside a failing operation; both adapters treat
      // a second rollback as a no-op.
      await payload.db.rollbackTransaction(transactionID)
    } else if (createdUserId !== undefined) {
      await payload
        .delete({ collection: 'users', id: createdUserId, depth: 0 })
        .catch((err) => payload.logger.error({ err }, 'could not undo partial first-run setup'))
    }
    throw error
  }
}

export interface SetupSession {
  token: string
  exp?: number
  /** Ready-to-send `Set-Cookie` header value for the `payload-token` cookie. */
  cookie: string
}

/**
 * Logs the freshly created admin in through Payload's own login operation and returns the token
 * plus the `Set-Cookie` header the browser needs, so the setup response leaves the user signed in.
 */
export async function createSetupSession(
  payload: Payload,
  credentials: { email: string; password: string },
  headers?: Headers,
): Promise<SetupSession> {
  const { token, exp } = await payload.login({
    collection: 'users',
    data: credentials,
    depth: 0,
    req: headers ? { headers } : undefined,
  })
  if (!token) throw new SetupError('Login after setup did not return a token.', 500)

  const cookie = generatePayloadCookie({
    collectionAuthConfig: payload.collections.users.config.auth,
    cookiePrefix: payload.config.cookiePrefix,
    token,
  })

  return { token, exp, cookie }
}
