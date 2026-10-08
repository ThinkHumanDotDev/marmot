/**
 * Probe location tokens (#91), modelled on organization API keys (`src/server/api-keys`): tokens
 * look like `mp_<prefix>_<secret>`, only `sha256(token)` is stored, and the plaintext is shown once
 * when the location is created or its token rotated. The 8-character `prefix` is stored in clear so
 * people can tell tokens apart. Kept free of Payload imports so the agent can parse its token.
 */
import { createHash, randomBytes } from 'node:crypto'

export const PROBE_TOKEN_SCHEME = 'mp'
const PREFIX_LENGTH = 8
const SECRET_BYTES = 32
export const PROBE_TOKEN_PATTERN = /^mp_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{40,50})$/

export interface GeneratedProbeToken {
  /** Plaintext token: shown once, never stored. */
  token: string
  prefix: string
  tokenHash: string
}

export const hashProbeToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export function generateProbeToken(): GeneratedProbeToken {
  const prefix = randomBytes(PREFIX_LENGTH * 2)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, PREFIX_LENGTH)
    .padEnd(PREFIX_LENGTH, '0')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const token = `${PROBE_TOKEN_SCHEME}_${prefix}_${secret}`
  return { token, prefix, tokenHash: hashProbeToken(token) }
}

/** Public form of a token for lists: `mp_<prefix>_••••`. */
export const displayProbeToken = (prefix: string): string =>
  `${PROBE_TOKEN_SCHEME}_${prefix}_••••••••`

/** The token of `Authorization: Bearer mp_…`, or `null` when there is none that looks right. */
export function extractProbeToken(headers: Headers): string | null {
  const authorization = headers.get('authorization')
  if (!authorization) return null
  const [scheme, ...rest] = authorization.trim().split(/\s+/)
  const value = rest.join(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !PROBE_TOKEN_PATTERN.test(value)) return null
  return value
}
