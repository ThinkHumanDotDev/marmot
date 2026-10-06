import { APIError, type Payload } from 'payload'

import { verifyPassword } from '@/auth/password'
import { hasPassword } from '@/collections/Users'
import type { RequestUser } from '@/server/http'

/**
 * Sensitive 2FA operations re-authenticate the session user. Password accounts must repeat their
 * password; single sign-on accounts have none Marmot knows, so for them the session (and, where
 * asked, a valid code) is the proof.
 */
export async function requirePassword(
  payload: Payload,
  user: RequestUser,
  password: unknown,
): Promise<void> {
  if (!hasPassword(user)) return
  if (typeof password !== 'string' || !password) {
    throw new APIError('Enter your password.', 400)
  }
  if (!(await verifyPassword(payload, user.email, password))) {
    throw new APIError('Your password is incorrect.', 401)
  }
}

export function requireCode(code: unknown): string {
  if (typeof code !== 'string' || !code.trim()) {
    throw new APIError('Enter the code from your authenticator app.', 400)
  }
  return code.trim()
}
