/**
 * `GET /status/:slug/badge.svg` (issue #110): one badge with the overall state of a status page.
 *
 * The state is derived from the same public payload the page renders (`buildPublicStatusPageData`,
 * whose `overall` comes from `overallStatus`), refined with incident impact on components and running
 * maintenance windows, so the badge never disagrees with the page. Only the headline state leaves
 * the process: no uptime, response times or monitor names, whatever the page's display settings.
 *
 * Every request goes through `statusPageBadgeAccess`, the one place that decides whether the page
 * may be shown to this visitor; a page the visitor may not see renders an `Unknown` badge.
 */
import type { Payload } from 'payload'

import { worstImpact, type ComponentImpact } from '@/lib/status-page-components'
import {
  renderStatusPageBadge,
  statusPageBadgeOptions,
  type StatusPageBadgeState,
  STATUS_PAGE_BADGE_STATES,
} from '@/server/badges/status-page'
import {
  buildPublicStatusPageData,
  findPublishedStatusPage,
  type OverallStatus,
} from '@/server/status-pages/public'

import type { StatusPage } from '@/payload-types'

/** What the headline needs from `PublicStatusPageData`. */
export interface BadgeStateInput {
  overall: OverallStatus
  /** Components; `impact` is the worst impact of the active incidents affecting the component. */
  groups: readonly { monitors: readonly { impact: ComponentImpact | null }[] }[]
  maintenance: readonly { status: string }[]
}

const FROM_OVERALL: Record<OverallStatus, StatusPageBadgeState> = {
  up: 'operational',
  partial: 'partial',
  down: 'major',
  maintenance: 'maintenance',
  unknown: 'unknown',
}

const FROM_IMPACT: Record<ComponentImpact, StatusPageBadgeState | undefined> = {
  operational: undefined,
  degraded_performance: 'degraded',
  partial_outage: 'partial',
  major_outage: 'major',
}

const severity = (state: StatusPageBadgeState) => STATUS_PAGE_BADGE_STATES.indexOf(state)

/**
 * Headline state of a page: the most severe of
 * - the page's `overall` status (all up → operational, some down → partial, all down → major,
 *   monitors in maintenance → maintenance, nothing checked yet → unknown);
 * - the worst incident impact on any component (degraded performance / partial / major outage);
 * - a running maintenance window attached to the page.
 *
 * Severity: major > partial > degraded > maintenance > operational > unknown.
 */
export function statusPageBadgeState(data: BadgeStateInput): StatusPageBadgeState {
  let state = FROM_OVERALL[data.overall] ?? 'unknown'
  const raise = (next: StatusPageBadgeState | undefined) => {
    if (next && severity(next) > severity(state)) state = next
  }
  const impact = worstImpact(data.groups.flatMap((g) => g.monitors.map((m) => m.impact)))
  if (impact) raise(FROM_IMPACT[impact])
  if (data.maintenance.some((m) => m.status === 'under-maintenance')) raise('maintenance')
  return state
}

export interface BadgePageAccess {
  allowed: boolean
  /** The answer depends on the visitor's credentials: never store it in a shared cache. */
  restricted: boolean
}

/**
 * May the page's real state be shown to the visitor behind `request`? The single access check of
 * the badge route: password protection (#102) and later access modes plug in here. Today every
 * published page is public.
 */
export async function statusPageBadgeAccess(
  _payload: Payload,
  _page: StatusPage,
  _request: Request,
): Promise<BadgePageAccess> {
  return { allowed: true, restricted: false }
}

/** Shared caches keep a badge for the page's auto-refresh interval (5 minutes when it is off). */
export const DEFAULT_BADGE_MAX_AGE = 300
export const MIN_BADGE_MAX_AGE = 30

export const badgeMaxAge = (page: Pick<StatusPage, 'autoRefreshInterval'>): number => {
  const interval = page.autoRefreshInterval ?? 0
  return interval > 0 ? Math.max(MIN_BADGE_MAX_AGE, Math.round(interval)) : DEFAULT_BADGE_MAX_AGE
}

const svgHeaders = (cacheControl: string): Record<string, string> => ({
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'Cache-Control': cacheControl,
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
})

const NO_STORE = 'no-store'
const PRIVATE_NO_STORE = 'private, no-store'

/**
 * Serves the badge. Unknown or unpublished slugs answer `404` with an `Unknown` badge (so an embed
 * shows something sensible); pages the visitor may not see answer `200` with an `Unknown` badge.
 */
export async function serveStatusPageBadge(
  payload: Payload,
  request: Request,
  slug: string,
): Promise<Response> {
  const options = statusPageBadgeOptions(new URL(request.url).searchParams)
  const unknown = (status: number, cacheControl: string) =>
    new Response(renderStatusPageBadge('unknown', options), {
      status,
      headers: svgHeaders(cacheControl),
    })

  const page = await findPublishedStatusPage(payload, slug)
  if (!page) return unknown(404, NO_STORE)

  const access = await statusPageBadgeAccess(payload, page, request)
  if (!access.allowed) return unknown(200, NO_STORE)

  const data = await buildPublicStatusPageData(payload, page)
  const state = statusPageBadgeState(data)
  const cacheControl = access.restricted ? PRIVATE_NO_STORE : `public, max-age=${badgeMaxAge(page)}`
  return new Response(renderStatusPageBadge(state, options), {
    status: 200,
    headers: svgHeaders(cacheControl),
  })
}
