/**
 * Pure helpers for the opt-in product analytics (PostHog). No SDK import, so this module is safe
 * in server components, the client bundle and unit tests alike. See `docs/telemetry.md`.
 *
 * `NEXT_PUBLIC_*` variables are inlined by Next.js at build time, so they must be read from
 * `process.env` directly here (the zod-validated `src/env.ts` is server-only). Server code uses
 * `src/server/analytics.ts`, which goes through `env`.
 */

/** Same-origin path the PostHog client talks to; `next.config.ts` rewrites it to the PostHog host. */
export const POSTHOG_PROXY_PATH = '/ph'

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

/** Public documentation of what the analytics collect (linked from the consent banner). */
export const TELEMETRY_DOCS_URL =
  'https://github.com/ThinkHumanDotDev/marmot/blob/main/docs/telemetry.md'

/** The project key, or `undefined` when analytics are off (the default on self-hosted installs). */
export function analyticsKey(): string | undefined {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
  const trimmed = key?.trim()
  return trimmed ? trimmed : undefined
}

/** Analytics are enabled only when an operator set `NEXT_PUBLIC_POSTHOG_KEY`. */
export function isAnalyticsEnabled(): boolean {
  return analyticsKey() !== undefined
}

/**
 * PostHog's app UI host for an ingestion host: `https://us.i.posthog.com` → `https://us.posthog.com`.
 * Self-hosted PostHog instances use the same host for both.
 */
export function posthogUiHost(apiHost: string | undefined = DEFAULT_POSTHOG_HOST): string {
  const host = (apiHost?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '')
  return host.replace(/^(https?:\/\/[a-z0-9-]+)\.i\.posthog\.com$/i, '$1.posthog.com')
}

/** Top-level routes that are not organization slugs. */
const STATIC_ROUTES = new Set([
  'login',
  'signup',
  'forgot-password',
  'reset-password',
  'setup',
  'onboarding',
  'admin',
])

/** Routes whose second segment is an identifier (`/invite/<code>`, `/status/<slug>`). */
const ID_AFTER_FIRST = new Set(['invite', 'status'])

const looksLikeId = (segment: string): boolean =>
  /^\d+$/.test(segment) || /^[a-f0-9]{24}$/i.test(segment) || /^[0-9a-f-]{36}$/i.test(segment)

/**
 * Collapses a pathname to its route pattern so analytics never see organization slugs, document
 * ids or tokens: `/acme/monitors/12/edit` → `/[org]/monitors/[id]/edit`, `/invite/abc` →
 * `/invite/[code]`, `/status/acme-prod` → `/status/[slug]`.
 */
export function routePattern(pathname: string): string {
  const segments = pathname.split('?')[0]!.split('#')[0]!.split('/').filter(Boolean)
  if (segments.length === 0) return '/'

  const [first, ...rest] = segments as [string, ...string[]]
  if (ID_AFTER_FIRST.has(first)) {
    const tail = rest.slice(1).map((s) => (looksLikeId(s) ? '[id]' : s))
    const placeholder = first === 'invite' ? '[code]' : '[slug]'
    return `/${[first, ...(rest.length > 0 ? [placeholder] : []), ...tail].join('/')}`
  }
  if (STATIC_ROUTES.has(first)) {
    return `/${[first, ...rest.map((s) => (looksLikeId(s) ? '[id]' : s))].join('/')}`
  }
  // Everything else lives under an organization slug.
  return `/${['[org]', ...rest.map((s) => (looksLikeId(s) ? '[id]' : s))].join('/')}`
}

const URL_PROPERTIES = ['$current_url', '$initial_current_url'] as const
const PATH_PROPERTIES = ['$pathname', '$initial_pathname'] as const
const DROPPED_PROPERTIES = [
  '$referrer',
  '$referring_domain',
  '$initial_referrer',
  '$initial_referring_domain',
  '$host',
  '$initial_host',
  '$ip',
] as const

function scrubRecord(record: Record<string, unknown>): void {
  for (const key of URL_PROPERTIES) {
    const value = record[key]
    if (typeof value === 'string') record[key] = routePattern(pathnameOf(value))
  }
  for (const key of PATH_PROPERTIES) {
    const value = record[key]
    if (typeof value === 'string') record[key] = routePattern(value)
  }
  for (const key of DROPPED_PROPERTIES) delete record[key]
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname
  } catch {
    return url
  }
}

/** Minimal shape of posthog-js's `CaptureResult` that the sanitizer touches. */
export interface CaptureLike {
  event: string
  properties?: Record<string, unknown>
  $set?: Record<string, unknown>
  $set_once?: Record<string, unknown>
}

/**
 * `before_send` hook: rewrites URL-ish properties to route patterns and drops referrers and
 * hosts, on the event itself and on the person-property buckets (`$set`, `$set_once`).
 */
export function sanitizeCaptureResult<T extends CaptureLike | null>(result: T): T {
  if (!result) return result
  if (result.properties) {
    scrubRecord(result.properties)
    for (const bucket of ['$set', '$set_once'] as const) {
      const nested = result.properties[bucket]
      if (nested && typeof nested === 'object') scrubRecord(nested as Record<string, unknown>)
    }
  }
  for (const bucket of ['$set', '$set_once'] as const) {
    const nested = result[bucket]
    if (nested) scrubRecord(nested)
  }
  return result
}
