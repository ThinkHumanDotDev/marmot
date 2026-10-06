/**
 * Client-side product analytics facade. Every function is a no-op unless BOTH hold:
 *
 * 1. the operator enabled analytics (`NEXT_PUBLIC_POSTHOG_KEY` set, SDK initialised by
 *    `src/instrumentation-client.ts`), and
 * 2. the visitor granted the `measurement` consent category in the cookie banner
 *    (`src/components/consent/*` calls `setAnalyticsConsent`).
 *
 * Users are identified by a server-computed keyed hash of their id (`hashAnalyticsId` in
 * `src/server/analytics.ts`), never by email or name. See `docs/Telemetry.md`.
 */
import posthog from 'posthog-js'

import { isAnalyticsEnabled, routePattern } from './analytics-config'

export * from './analytics-config'

export type AnalyticsProperties = Record<string, string | number | boolean | null | undefined>

export interface IdentifyTraits {
  /** Plan of the organization the user is looking at (`free`, `team`, …). */
  plan?: string
}

/** `undefined` until the consent manager reports the visitor's choice. */
let consentGranted: boolean | undefined
/** Identity to apply once (or whenever) consent is granted. */
let pendingIdentity: { id: string; traits?: IdentifyTraits } | undefined

/** The initialised SDK, or `undefined` while analytics are disabled or not yet booted. */
function client(): typeof posthog | undefined {
  if (!isAnalyticsEnabled() || typeof window === 'undefined' || !posthog.__loaded) return undefined
  return posthog
}

/** Whether events currently leave the browser. */
export function hasAnalyticsConsent(): boolean {
  return consentGranted === true
}

/**
 * Applies the visitor's `measurement` consent to the SDK: opt in (and replay a pending
 * `identify`) when granted; opt out and wipe the SDK's local state when denied.
 */
export function setAnalyticsConsent(granted: boolean): void {
  if (granted === consentGranted) return
  consentGranted = granted
  const ph = client()
  if (!ph) return
  if (granted) {
    ph.opt_in_capturing({ captureEventName: false })
    if (pendingIdentity) ph.identify(pendingIdentity.id, pendingIdentity.traits)
  } else {
    ph.opt_out_capturing()
    // Forget distinct id, super properties and session (reset returns to the opted-out default).
    ph.reset()
  }
}

/** Captures a product event. Silently dropped without analytics or consent. */
export function track(event: string, properties?: AnalyticsProperties): void {
  if (!hasAnalyticsConsent()) return
  client()?.capture(event, properties)
}

/** Captures a pageview for a route pattern (never the raw path: no slugs, ids or query). */
export function trackPageview(pathname: string): void {
  const pattern = routePattern(pathname)
  track('$pageview', { $current_url: pattern, $pathname: pattern })
}

/**
 * Links the browser to a hashed user id. Remembered until consent arrives, so layouts may call it
 * on mount; without analytics it does nothing.
 */
export function identify(hashedUserId: string, traits?: IdentifyTraits): void {
  if (!isAnalyticsEnabled()) return
  pendingIdentity = { id: hashedUserId, traits }
  if (!hasAnalyticsConsent()) return
  client()?.identify(hashedUserId, traits)
}

/** Forgets the identified user (sign-out). */
export function resetAnalytics(): void {
  pendingIdentity = undefined
  client()?.reset()
}

/** Test hook: back to the pristine module state. */
export function __resetAnalyticsStateForTests(): void {
  consentGranted = undefined
  pendingIdentity = undefined
}
