import type { Payload } from 'payload'

import { verifyPassword } from '@/auth/password'
import { hasPassword } from '@/collections/Users'
import type { RequestUser } from '@/server/http'
import { apiError } from '@/server/errors'

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
    throw apiError('enterPassword', 400)
  }
  if (!(await verifyPassword(payload, user.email, password))) {
    throw apiError('passwordIncorrect', 401)
  }
}

export function requireCode(code: unknown): string {
  if (typeof code !== 'string' || !code.trim()) {
    throw apiError('enterTotpCode', 400)
  }
  return code.trim()
}
