import { decodeJwt } from 'jose'
import type { Payload } from 'payload'

import { TWO_FACTOR_GATE_CONTEXT } from '@/collections/Users'
import type { User } from '@/payload-types'

import { revokePayloadSession } from './oidc/session'

/**
 * Checks a password without leaving a session behind. Payload has no "verify only" operation, so
 * this logs in through the Local API (which also enforces `maxLoginAttempts` / `lockTime`) and
 * immediately revokes the session it created. The two-factor gate (`users.hooks.beforeLogin`) is
 * bypassed on purpose: this is a re-authentication of an already signed-in user, not a login.
 */
export async function verifyPassword(
  payload: Payload,
  email: string,
  password: string,
): Promise<boolean> {
  let token: string | undefined
  let userId: User['id'] | undefined
  try {
    const result = await payload.login({
      collection: 'users',
      data: { email, password },
      depth: 0,
      context: { [TWO_FACTOR_GATE_CONTEXT]: true },
    })
    token = result.token
    userId = result.user?.id
  } catch {
    return false
  }
  if (token && userId !== undefined) {
    const sid = decodeJwt(token).sid
    await revokePayloadSession({
      payload,
      userId,
      sid: typeof sid === 'string' ? sid : undefined,
    })
  }
  return true
}
