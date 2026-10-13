/**
 * Integration tokens (#152): `mi` + 40 lowercase hex characters (160 random bits). The token is the
 * secret of `POST /api/inbound/<token>` and the local part of `<token>@INBOUND_EMAIL_DOMAIN`; only
 * its SHA-256 is stored (`tokenHash`), next to a short `tokenPrefix` for display.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { INTEGRATION_TOKEN_PREFIX_LENGTH } from '@/lib/inbound-alerts'

export interface GeneratedIntegrationToken {
  token: string
  hash: string
  prefix: string
}

export const hashIntegrationToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export function generateIntegrationToken(): GeneratedIntegrationToken {
  const token = `mi${randomBytes(20).toString('hex')}`
  return {
    token,
    hash: hashIntegrationToken(token),
    prefix: token.slice(0, INTEGRATION_TOKEN_PREFIX_LENGTH),
  }
}

/** Constant-time comparison of a presented token with a stored hash. */
export function integrationTokenMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashIntegrationToken(presented), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
