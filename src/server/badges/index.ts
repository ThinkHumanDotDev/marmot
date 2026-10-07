/**
 * Badge endpoint glue: parse the URL, check access, load the figures and render. Kept out of the
 * route file so tests can call it with a plain `Request`.
 */
import type { Payload } from 'payload'

import type { Monitor } from '@/payload-types'
import { getAvgPing, getUptime } from '@/server/stats/uptime-calculator'
import { readCertInfo } from '@/server/metrics/prometheus'
import { errorText } from '@/server/request-locale'
import { badgeAccess } from './access'
import {
  badgeParamsFromSearch,
  buildBadge,
  isBadgeType,
  parseBadgeDuration,
  renderBadge,
  type BadgeData,
  type BadgeType,
} from './badge'

export * from './badge'
export * from './access'

/** Shields-style badges are embedded cross-origin and cached by CDNs for five minutes (Kuma). */
export const BADGE_HEADERS = {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
} as const

const parseId = (payload: Payload, raw: string): string | number =>
  payload.db.defaultIDType === 'number' && /^\d+$/.test(raw) ? Number(raw) : raw

const jsonError = (status: number, message: string) =>
  Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } })

/**
 * `GET /api/badge/:monitorId/<type>[/<duration>]`. `segments` is the path after the monitor id,
 * e.g. `['uptime', '30d']`.
 */
export async function serveBadge(
  payload: Payload,
  request: Request,
  rawMonitorId: string,
  segments: string[],
): Promise<Response> {
  const [typeSegment, durationSegment, ...rest] = segments
  if (!isBadgeType(typeSegment) || rest.length > 0)
    return jsonError(404, errorText(request, 'badgeUnknown'))
  const type: BadgeType = typeSegment
  const wantsDuration = type === 'uptime' || type === 'ping' || type === 'avg-response'
  if (!wantsDuration && durationSegment !== undefined)
    return jsonError(404, errorText(request, 'badgeUnknown'))

  const range = wantsDuration ? parseBadgeDuration(durationSegment) : null
  if (wantsDuration && !range) {
    return jsonError(400, errorText(request, 'badgeDurationInvalid'))
  }

  const monitor = (await payload
    .findByID({
      collection: 'monitors',
      id: parseId(payload, rawMonitorId),
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })
    .catch(() => null)) as Monitor | null
  if (!monitor) return jsonError(404, errorText(request, 'monitorNotFound'))

  const access = await badgeAccess(payload, monitor, request)
  if (!access) return jsonError(404, errorText(request, 'monitorNotFound'))

  const data: BadgeData = { range: range ?? undefined }
  switch (type) {
    case 'status':
      data.status = monitor.status?.lastStatus ?? null
      break
    case 'uptime':
      data.uptime = await getUptime(payload, monitor.id, range ?? '24h')
      break
    case 'ping':
    case 'avg-response':
      data.avgPing = await getAvgPing(payload, monitor.id, range ?? '24h')
      break
    case 'response':
      data.lastPing = monitor.status?.lastPing ?? null
      break
    case 'cert-exp':
      data.cert = readCertInfo(monitor)
      break
  }

  const params = badgeParamsFromSearch(new URL(request.url).searchParams)
  const svg = renderBadge(buildBadge(type, data, params))
  // Badges served through a protected status page must not land in shared caches.
  const headers =
    access === 'status-page'
      ? { ...BADGE_HEADERS, 'Cache-Control': 'private, no-store' }
      : BADGE_HEADERS
  return new Response(svg, { status: 200, headers })
}
