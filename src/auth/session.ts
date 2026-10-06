import {
  createSessionCookie,
  expiredSessionCookie,
  readCookie,
  revokeSession,
  type SessionCookie,
} from '@thinkhumandotdev/payload-auth'
import type { Payload } from 'payload'

import { env } from '@/env'
import type { User } from '@/payload-types'

/**
 * Payload sessions for logins Marmot completes itself (single sign-on callback, second factor):
 * thin wrappers over `@thinkhumandotdev/payload-auth` bound to the `users` collection. The result
 * is indistinguishable from `POST /api/users/login` for `payload.auth`, the admin panel and the
 * realtime server.
 */
export type PayloadSessionCookie = SessionCookie

export const createPayloadSessionCookie = ({
  payload,
  userId,
}: {
  payload: Payload
  userId: User['id']
}): Promise<PayloadSessionCookie> =>
  createSessionCookie({ payload, collectionSlug: 'users', userId })

/** `Set-Cookie` value that removes the Payload auth cookie (same attributes as `logout`). */
export const expiredPayloadCookie = (payload: Payload): string =>
  expiredSessionCookie(payload, 'users')

/** Removes one session (`sid` from the JWT) from the user so that token stops authenticating. */
export const revokePayloadSession = ({
  payload,
  userId,
  sid,
}: {
  payload: Payload
  userId: User['id']
  sid: string | undefined
}): Promise<void> => revokeSession({ payload, collectionSlug: 'users', userId, sid })

const serverUrl = () => env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')

/** `Secure` cookies when Marmot is served over https. */
export const cookiesAreSecure = (): boolean => serverUrl().startsWith('https://')

export { readCookie }
