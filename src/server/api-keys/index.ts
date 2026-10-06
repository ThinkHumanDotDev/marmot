/**
 * Organization API keys: minting, hashing and request authentication.
 *
 * Keys look like `mk_<prefix>_<secret>`: `mk_` marks a Marmot key, the 8-char `prefix` is the
 * public identifier stored in clear (and shown in the UI), and the secret is 32 random bytes in
 * base64url. Only `sha256(plaintext)` is stored, so a database leak does not leak keys.
 *
 * Clients send the key as `Authorization: Bearer <key>`, `X-API-Key: <key>` or, for scrapers that
 * only speak HTTP basic auth (Prometheus `basic_auth`), as the password of `Authorization: Basic`
 * with any username. Inspired by Uptime Kuma 2.5.5 `server/auth.js` (`apiAuth`) and
 * `server/model/api_key.js` (MIT, Louis Lam).
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { ApiKey } from '@/payload-types'

const log = childLogger('api-keys')

export const API_KEY_SCHEME = 'mk'
const PREFIX_LENGTH = 8
const SECRET_BYTES = 32
const KEY_PATTERN = /^mk_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{40,50})$/

/** `lastUsedAt` is refreshed at most once per minute per key to keep scrapes cheap. */
export const LAST_USED_THROTTLE_MS = 60_000

export type OrgId = string | number

export interface GeneratedApiKey {
  /** Plaintext key — shown to the user once, never stored. */
  key: string
  prefix: string
  keyHash: string
}

export const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex')

/** Mint a new key. The prefix is alphanumeric so it reads well in logs and the UI. */
export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(PREFIX_LENGTH * 2)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, PREFIX_LENGTH)
    .padEnd(PREFIX_LENGTH, '0')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const key = `${API_KEY_SCHEME}_${prefix}_${secret}`
  return { key, prefix, keyHash: hashApiKey(key) }
}

/** Public form of a key for lists: `mk_<prefix>_••••`. */
export const displayApiKey = (prefix: string): string => `${API_KEY_SCHEME}_${prefix}_••••••••`

/**
 * Extract the API key from the request. Order: `X-API-Key`, `Authorization: Bearer`,
 * `Authorization: Basic` (password part). Returns `null` when none looks like a Marmot key.
 */
export function extractApiKey(headers: Headers): string | null {
  const candidates: string[] = []
  const xApiKey = headers.get('x-api-key')
  if (xApiKey) candidates.push(xApiKey.trim())

  const authorization = headers.get('authorization')
  if (authorization) {
    const [scheme, ...rest] = authorization.trim().split(/\s+/)
    const value = rest.join(' ')
    if (scheme?.toLowerCase() === 'bearer' && value) {
      candidates.push(value)
    } else if (scheme?.toLowerCase() === 'basic' && value) {
      try {
        const decoded = Buffer.from(value, 'base64').toString('utf8')
        const separator = decoded.indexOf(':')
        const password = separator >= 0 ? decoded.slice(separator + 1) : decoded
        if (password) candidates.push(password)
      } catch {
        // not base64; ignore
      }
    }
  }

  return candidates.find((candidate) => KEY_PATTERN.test(candidate)) ?? null
}

export interface ApiKeyAuth {
  organizationId: OrgId
  apiKey: ApiKey
}

export type ApiKeyStatus = 'active' | 'inactive' | 'expired'

/** Kuma's `APIKey.getStatus()`. */
export function apiKeyStatus(
  doc: Pick<ApiKey, 'active' | 'expiresAt'>,
  now: Date = new Date(),
): ApiKeyStatus {
  if (doc.expiresAt && new Date(doc.expiresAt).getTime() < now.getTime()) return 'expired'
  return doc.active === false ? 'inactive' : 'active'
}

const relationId = (value: unknown): OrgId | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id: OrgId }).id ?? null
  return value as OrgId
}

/**
 * Resolve the key carried by `request` to its organization. Returns `null` for missing, unknown,
 * disabled or expired keys. Updates `lastUsedAt` in the background (throttled).
 */
export async function authenticateApiKey(
  payload: Payload,
  request: Request | { headers: Headers },
  options: { now?: Date } = {},
): Promise<ApiKeyAuth | null> {
  const key = extractApiKey(request.headers)
  if (!key) return null
  return authenticateApiKeyValue(payload, key, options)
}

/** Same as `authenticateApiKey` for an already extracted plaintext key. */
export async function authenticateApiKeyValue(
  payload: Payload,
  key: string,
  options: { now?: Date } = {},
): Promise<ApiKeyAuth | null> {
  if (!KEY_PATTERN.test(key)) return null
  const now = options.now ?? new Date()

  const { docs } = await payload.find({
    collection: 'api-keys',
    where: { keyHash: { equals: hashApiKey(key) } },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  const apiKey = docs[0] as ApiKey | undefined
  if (!apiKey) return null
  if (apiKeyStatus(apiKey, now) !== 'active') return null

  const organizationId = relationId(apiKey.organization)
  if (organizationId === null) return null

  const lastUsed = apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).getTime() : 0
  if (now.getTime() - lastUsed >= LAST_USED_THROTTLE_MS) {
    void payload
      .update({
        collection: 'api-keys',
        id: apiKey.id,
        data: { lastUsedAt: now.toISOString() },
        depth: 0,
        overrideAccess: true,
      })
      .catch((err: unknown) => log.warn({ err, apiKeyId: apiKey.id }, 'failed to stamp lastUsedAt'))
  }

  return { organizationId, apiKey }
}

/** Fields the UI receives; `keyHash` never leaves the server. */
export interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  display: string
  active: boolean
  status: ApiKeyStatus
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export function toApiKeyRow(doc: ApiKey, now: Date = new Date()): ApiKeyRow {
  return {
    id: String(doc.id),
    name: doc.name,
    prefix: doc.prefix,
    display: displayApiKey(doc.prefix),
    active: doc.active !== false,
    status: apiKeyStatus(doc, now),
    expiresAt: doc.expiresAt ?? null,
    lastUsedAt: doc.lastUsedAt ?? null,
    createdAt: doc.createdAt,
  }
}
