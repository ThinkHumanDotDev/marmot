/**
 * Server-side analytics (posthog-node) for aggregate, non-personal instance events such as
 * `instance_started` and `org_created`, plus the keyed hash that turns ids into analytics
 * identifiers. Gated by the same `NEXT_PUBLIC_POSTHOG_KEY` as the browser SDK: without it every
 * function is a no-op and the SDK is never instantiated. Imported by the worker (bundled with
 * esbuild) and by Payload hooks in the web process, so it must stay bundle-safe: static imports
 * only. See `docs/Telemetry.md`.
 */
import { createHash, createHmac } from 'node:crypto'

import { PostHog } from 'posthog-node'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'

const log = childLogger('analytics')

let client: PostHog | undefined

/** Analytics are on only when the operator set a PostHog project key. */
export function isServerAnalyticsEnabled(): boolean {
  return Boolean(env.NEXT_PUBLIC_POSTHOG_KEY?.trim())
}

/**
 * Salt derived from `PAYLOAD_SECRET` (never the secret itself), stable for the lifetime of an
 * installation so the same user always maps to the same analytics id.
 */
export function analyticsSalt(secret: string = env.PAYLOAD_SECRET): string {
  return createHash('sha256').update(`marmot-analytics:${secret}`).digest('hex')
}

/**
 * Keyed SHA-256 (HMAC) of a document id with the installation salt. The output cannot be reversed
 * to the id, and ids of different installations never collide. Use it for every identifier that
 * reaches PostHog (user ids, organization ids).
 */
export function hashAnalyticsId(value: string | number, secret?: string): string {
  return createHmac('sha256', analyticsSalt(secret)).update(String(value)).digest('hex')
}

/** Distinct id of this installation for server events (no person profile is created for it). */
export function instanceDistinctId(): string {
  return `instance_${hashAnalyticsId('instance').slice(0, 32)}`
}

function getClient(): PostHog | undefined {
  if (!isServerAnalyticsEnabled()) return undefined
  if (!client) {
    client = new PostHog(env.NEXT_PUBLIC_POSTHOG_KEY!.trim(), {
      host: env.NEXT_PUBLIC_POSTHOG_HOST,
      // Server events are rare; send each one right away instead of batching.
      flushAt: 1,
      flushInterval: 5_000,
      disableGeoip: true,
    })
    client.on('error', (err: unknown) => {
      log.warn({ err }, 'analytics request failed')
    })
  }
  return client
}

/**
 * Captures an aggregate instance event. Callers pass only non-personal properties (versions,
 * adapter names, hashed ids); the event is attributed to the installation, not to a person.
 */
export function captureServerEvent(event: string, properties: Record<string, unknown> = {}): void {
  const ph = getClient()
  if (!ph) return
  try {
    ph.capture({
      distinctId: instanceDistinctId(),
      event,
      properties: { ...properties, $process_person_profile: false },
      disableGeoip: true,
    })
  } catch (err) {
    log.warn({ err, event }, 'failed to queue analytics event')
  }
}

/** Flushes queued events; call once before a process exits. Safe when analytics are off. */
export async function shutdownServerAnalytics(timeoutMs = 5_000): Promise<void> {
  const ph = client
  client = undefined
  if (!ph) return
  try {
    await ph.shutdown(timeoutMs)
  } catch (err) {
    log.warn({ err }, 'analytics shutdown failed')
  }
}
