import { createLocalReq, getFieldsToSign, jwtSign, type Payload, type TypedUser } from 'payload'
import {
  addSessionToUser,
  generateExpiredPayloadCookie,
  generatePayloadCookie,
} from 'payload/shared'

import type { User } from '@/payload-types'

/**
 * Establishes a Payload session for a user the OIDC callback has already authenticated, exactly
 * the way `POST /api/users/login` does: a session row on the user (`auth.useSessions`), a JWT
 * signed with the Payload secret carrying the collection's `saveToJWT` fields, and the
 * `${cookiePrefix}-token` cookie with the collection's `tokenExpiration`. The result is
 * indistinguishable from a password login for `payload.auth`, the admin panel and the realtime
 * server.
 *
 * Payload internals relied on (all public exports of payload 3.x): `jwtSign`, `getFieldsToSign`,
 * `createLocalReq` from `payload`; `addSessionToUser`, `generatePayloadCookie`,
 * `generateExpiredPayloadCookie` from `payload/shared`.
 */
export interface PayloadSessionCookie {
  /** Full `Set-Cookie` header value. */
  cookie: string
  token: string
  exp: number
}

type RawUser = TypedUser & {
  sessions?: { id: string; createdAt: Date | string; expiresAt: Date | string }[]
}

/** Loads the user as the login operation sees it (raw row incl. `sessions`, no access control). */
async function findRawUser(payload: Payload, id: User['id']): Promise<RawUser | null> {
  const doc = await payload.db.findOne<RawUser>({
    collection: 'users',
    where: { id: { equals: id } },
  })
  return doc ?? null
}

export async function createPayloadSessionCookie({
  payload,
  userId,
}: {
  payload: Payload
  userId: User['id']
}): Promise<PayloadSessionCookie> {
  const collection = payload.collections.users
  if (!collection?.config.auth) throw new Error('users collection is not auth-enabled')
  const collectionConfig = collection.config

  const user = await findRawUser(payload, userId)
  if (!user) throw new Error('User not found')
  user.collection = 'users'

  const req = await createLocalReq({}, payload)
  const { sid } = await addSessionToUser({ collectionConfig, payload, req, user })

  const fieldsToSign = getFieldsToSign({
    collectionConfig,
    email: typeof user.email === 'string' ? user.email : '',
    sid,
    user,
  })
  const { exp, token } = await jwtSign({
    fieldsToSign,
    secret: payload.secret,
    tokenExpiration: collectionConfig.auth.tokenExpiration,
  })

  const cookie = generatePayloadCookie({
    collectionAuthConfig: collectionConfig.auth,
    cookiePrefix: payload.config.cookiePrefix,
    token,
  })
  return { cookie, token, exp }
}

/** `Set-Cookie` value that removes the Payload auth cookie (same attributes as `logout`). */
export function expiredPayloadCookie(payload: Payload): string {
  return generateExpiredPayloadCookie({
    collectionAuthConfig: payload.collections.users.config.auth,
    cookiePrefix: payload.config.cookiePrefix,
  })
}

/** Removes one session (`sid` from the JWT) from the user so that token stops authenticating. */
export async function revokePayloadSession({
  payload,
  userId,
  sid,
}: {
  payload: Payload
  userId: User['id']
  sid: string | undefined
}): Promise<void> {
  if (!sid) return
  const user = await findRawUser(payload, userId)
  if (!user?.sessions?.length) return
  const remaining = user.sessions.filter((session) => session.id !== sid)
  if (remaining.length === user.sessions.length) return
  await payload.db.updateOne({
    id: user.id,
    collection: 'users',
    data: { ...user, sessions: remaining, updatedAt: null },
    returning: false,
  })
}
