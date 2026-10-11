import type { Payload } from 'payload'

import { env } from '@/env'
import type { InstanceSetting } from '@/payload-types'

/** Instance settings with every optional field resolved to its default. */
export interface InstanceSettings {
  primaryBaseUrl: string
  allowSignup: boolean
  requireEmailVerification: boolean
  magicLinkEnabled: boolean
  entryPage: 'dashboard' | 'status-page'
  tlsExpiryNotifyDays: number[]
  domainExpiryNotifyDays: number[]
  keepDataPeriodDays: number
  trustProxy: boolean
  steamApiKey: string | null
  globalpingApiToken: string | null
}

/** Days-before-expiry at which TLS / domain expiry notifications fire (Uptime Kuma defaults). */
export const DEFAULT_EXPIRY_NOTIFY_DAYS: readonly number[] = [7, 14, 21]

export const INSTANCE_SETTINGS_CACHE_MS = 60_000

type CachedSettings = { value: InstanceSettings; expiresAt: number }
const CACHE_KEY = Symbol.for('marmot.instance-settings.cache')
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: CachedSettings }

/**
 * The cache lives on `globalThis`: a production Next.js server evaluates this module once per
 * route bundle and layer, so a module-level variable would give the login page its own copy that
 * the global's `afterChange` (reached through the REST route) never resets.
 */
const cache = globalThis as GlobalWithCache

/** Drops the in-memory copy so the next `getInstanceSettings()` reads the database. */
export function resetInstanceSettingsCache(): void {
  delete cache[CACHE_KEY]
}

/**
 * Environment-derived defaults. Used for every field the global does not (yet) store a value
 * for, so a fresh install behaves exactly like the env configuration describes.
 */
export function defaultInstanceSettings(): InstanceSettings {
  return {
    primaryBaseUrl: env.NEXT_PUBLIC_SERVER_URL,
    allowSignup: !env.DISABLE_SIGNUP,
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION,
    magicLinkEnabled: env.MAGIC_LINK_ENABLED,
    entryPage: 'dashboard',
    tlsExpiryNotifyDays: [...DEFAULT_EXPIRY_NOTIFY_DAYS],
    domainExpiryNotifyDays: [...DEFAULT_EXPIRY_NOTIFY_DAYS],
    keepDataPeriodDays: env.KEEP_DATA_PERIOD_DAYS,
    trustProxy: false,
    steamApiKey: null,
    globalpingApiToken: null,
  }
}

const numbers = (value: unknown, fallback: number[]): number[] => {
  if (!Array.isArray(value)) return fallback
  const list = value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  return list.length > 0 ? list : fallback
}

/** The stored global with env defaults applied to every unset field. */
export function resolveInstanceSettings(
  doc: Partial<InstanceSetting> | null | undefined,
): InstanceSettings {
  const defaults = defaultInstanceSettings()
  if (!doc) return defaults
  return {
    primaryBaseUrl: doc.primaryBaseUrl?.trim() || defaults.primaryBaseUrl,
    allowSignup: typeof doc.allowSignup === 'boolean' ? doc.allowSignup : defaults.allowSignup,
    requireEmailVerification:
      typeof doc.requireEmailVerification === 'boolean'
        ? doc.requireEmailVerification
        : defaults.requireEmailVerification,
    magicLinkEnabled:
      typeof doc.magicLinkEnabled === 'boolean' ? doc.magicLinkEnabled : defaults.magicLinkEnabled,
    entryPage: doc.entryPage === 'status-page' ? 'status-page' : 'dashboard',
    tlsExpiryNotifyDays: numbers(doc.tlsExpiryNotifyDays, defaults.tlsExpiryNotifyDays),
    domainExpiryNotifyDays: numbers(doc.domainExpiryNotifyDays, defaults.domainExpiryNotifyDays),
    keepDataPeriodDays:
      typeof doc.keepDataPeriodDays === 'number'
        ? doc.keepDataPeriodDays
        : defaults.keepDataPeriodDays,
    trustProxy: typeof doc.trustProxy === 'boolean' ? doc.trustProxy : defaults.trustProxy,
    steamApiKey: doc.steamApiKey?.trim() || null,
    globalpingApiToken: doc.globalpingApiToken?.trim() || null,
  }
}

/**
 * Reads the `instance-settings` global with env defaults applied, caching the result in memory
 * for 60 seconds. Saving the global through Payload resets the cache in the same process; other
 * processes (worker, realtime) pick the change up when their copy expires.
 */
export async function getInstanceSettings(payload: Payload): Promise<InstanceSettings> {
  const now = Date.now()
  const cached = cache[CACHE_KEY]
  if (cached && cached.expiresAt > now) return cached.value

  let doc: InstanceSetting | null = null
  try {
    doc = await payload.findGlobal({ slug: 'instance-settings', depth: 0, overrideAccess: true })
  } catch (error) {
    payload.logger.warn({ err: error }, 'could not read instance settings; using env defaults')
  }

  const value = resolveInstanceSettings(doc)
  cache[CACHE_KEY] = { value, expiresAt: now + INSTANCE_SETTINGS_CACHE_MS }
  return value
}

/**
 * Whether anonymous visitors may create (password) accounts: `allowSignup`, defaulting to
 * `!DISABLE_SIGNUP`, and never in SSO-only mode (`OIDC_DISABLE_LOCAL_LOGIN`), where accounts come
 * from single sign-on only.
 */
export async function isSignupAllowed(payload: Payload): Promise<boolean> {
  // Demo mode (#159): everyone shares the demo account; new accounts would survive no reset.
  if (env.OIDC_DISABLE_LOCAL_LOGIN || env.DEMO_MODE) return false
  return (await getInstanceSettings(payload)).allowSignup
}

/**
 * Whether new self-service accounts must confirm their address before they may create
 * organizations, invitations or notification channels: `requireEmailVerification`, defaulting to
 * `REQUIRE_EMAIL_VERIFICATION` (off).
 */
export async function isEmailVerificationRequired(payload: Payload): Promise<boolean> {
  // Demo mode (#159): no signups, no address changes, and the demo accounts are verified; a
  // verification requirement could only lock the shared account out.
  if (env.DEMO_MODE) return false
  return (await getInstanceSettings(payload)).requireEmailVerification
}

/**
 * Whether people may sign in with a link sent to their address (#164): `magicLinkEnabled`,
 * defaulting to `MAGIC_LINK_ENABLED` (off). Sign-in links count as a local login, so the SSO-only
 * mode (`OIDC_DISABLE_LOCAL_LOGIN`) turns them off whatever the setting says.
 */
export async function isMagicLinkEnabled(payload: Payload): Promise<boolean> {
  // Demo mode (#159): the shared account's credentials stay fixed and no mail leaves the instance.
  if (env.OIDC_DISABLE_LOCAL_LOGIN || env.DEMO_MODE) return false
  return (await getInstanceSettings(payload)).magicLinkEnabled
}
