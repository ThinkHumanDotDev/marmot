/**
 * Shared plumbing for the status-page builder route handlers under
 * `/api/orgs/[orgId]/status-pages/**`. Every handler authenticates the Payload session and then
 * runs Local API calls with `user` + `overrideAccess: false`, so the collections' access rules
 * (`src/collections/StatusPages.ts`, `Incidents.ts`) are the single source of truth.
 */
import { APIError, getPayload, type Payload, type TypedUser } from 'payload'

import config from '@payload-config'
import { errorMessageFor, errorText, rememberRequestUser } from '@/server/request-locale'

import type { StatusPage } from '@/payload-types'

export type Authenticated = { payload: Payload; user: TypedUser }

export const jsonError = (message: string, status: number, details?: unknown) =>
  Response.json({ error: message, ...(details !== undefined ? { details } : {}) }, { status })

export async function authenticate(
  request: Request,
): Promise<{ ok: true; ctx: Authenticated } | { ok: false; response: Response }> {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: request.headers })
  if (!user) return { ok: false, response: jsonError(errorText(request, 'unauthenticated'), 401) }
  rememberRequestUser(request, user)
  return { ok: true, ctx: { payload, user } }
}

/** Postgres/SQLite use numeric ids, MongoDB uses strings. */
export function coerceId(payload: Payload, id: string): string | number {
  return payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    const body = (await request.json()) as unknown
    return body && typeof body === 'object' ? (body as T) : null
  } catch {
    return null
  }
}

/**
 * Maps Payload errors (validation, forbidden, not found) to JSON responses, with `apiError(…)`
 * messages in the request locale.
 */
export function errorResponse(error: unknown, request: Request): Response {
  if (error instanceof APIError) {
    const data = (error as APIError & { data?: unknown }).data
    return jsonError(errorMessageFor(request, error, 'unexpected'), error.status ?? 500, data)
  }
  return jsonError(errorMessageFor(request, error, 'unexpected'), 500)
}

/** Loads a status page with the user's access and checks it belongs to `orgId`. */
export async function loadOrgStatusPage(
  { payload, user }: Authenticated,
  orgId: string,
  id: string,
  depth = 1,
): Promise<StatusPage | null> {
  const { docs } = await payload.find({
    collection: 'status-pages',
    where: {
      and: [
        { id: { equals: coerceId(payload, id) } },
        { organization: { equals: coerceId(payload, orgId) } },
      ],
    },
    limit: 1,
    depth,
    user,
    overrideAccess: false,
  })
  return docs[0] ?? null
}

/** Fields of a status page a client may set through the builder API. */
export const STATUS_PAGE_WRITABLE_FIELDS = [
  'title',
  'slug',
  'description',
  'logo',
  'homepageUrl',
  'contactUrl',
  'theme',
  'themePreset',
  'themeOverrides',
  'bannerText',
  'language',
  'published',
  'access',
  // Write-only; hashed by the collection hook (`applyAccessPassword`).
  'password',
  'allowedEmailDomains',
  'allowedIpRanges',
  'searchEngineIndex',
  'showTags',
  'showCertificateExpiry',
  'showPoweredBy',
  'showValues',
  'autoRefreshInterval',
  'maintenanceVisibilityHours',
  'pastIncidentsDays',
  'footerText',
  'customCSS',
  'googleAnalyticsId',
  'domains',
  'groups',
] as const

/**
 * Fields a client may send when opening an incident. `content`/`style` (pre-timeline clients) and
 * `affectedComponents` become the first update.
 */
export const INCIDENT_CREATE_FIELDS = [
  'title',
  'pinned',
  'impact',
  'content',
  'style',
  'affectedComponents',
] as const

/**
 * Fields a client may patch on an incident. The timeline is changed through the updates routes;
 * `active` and `affectedComponents` are still accepted and post an update (`resolved` /
 * `investigating`, or the changed impacts with the current status).
 */
export const INCIDENT_WRITABLE_FIELDS = [
  'title',
  'pinned',
  'active',
  'impact',
  'affectedComponents',
] as const

/** Keeps only `allowed` keys so clients cannot move documents between organizations. */
export function pick<T extends Record<string, unknown>>(
  body: Record<string, unknown>,
  allowed: readonly string[],
): T {
  const out: Record<string, unknown> = {}
  for (const key of allowed) if (key in body) out[key] = body[key]
  return out as T
}
