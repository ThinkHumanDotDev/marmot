/**
 * Probe locations (#91), server side: authenticating agents by their location token, building
 * the monitor configuration they pull, and the rows the settings UI lists. Ingesting results lives
 * in `./ingest.ts`, offline detection in `./health.ts`, the wire format in `./wire.ts`.
 */
import { createHash } from 'node:crypto'

import type { Payload } from 'payload'

import { env } from '@/env'
import { clampInterval } from '@/lib/entitlements'
import { childLogger } from '@/lib/logger'
import { isMultiLocation, type LocationStatus } from '@/lib/probe-locations'
import type { DockerHost, Location, Monitor, MonitorProxy } from '@/payload-types'
import { minIntervalResolver } from '@/server/billing/entitlements'
import { createRateLimiter, type RateLimiter } from '@/server/security/rate-limit'

import { displayProbeToken, extractProbeToken, hashProbeToken } from './tokens'
import {
  PROBE_HOSTNAME_HEADER,
  PROBE_PLATFORM_HEADER,
  PROBE_USER_AGENT_PREFIX,
  type ProbeConfig,
  type ProbeMonitor,
} from './wire'

const log = childLogger('probes')

type Id = string | number

const relationId = (value: unknown): Id | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id?: Id }).id ?? null
  return value as Id
}

/** `lastSeenAt` is written at most this often per location (agents call in several times a minute). */
export const LAST_SEEN_THROTTLE_MS = 10_000

/** Seconds between config refreshes: three refreshes fit into `PROBE_OFFLINE_AFTER`, at most 60. */
export const probeRefreshSeconds = (offlineAfter: number = env.PROBE_OFFLINE_AFTER): number =>
  Math.max(10, Math.min(60, Math.floor(offlineAfter / 3)))

// ---- Authentication ---------------------------------------------------------------------------

export interface ProbeAgentInfo {
  version: string | null
  hostname: string | null
  platform: string | null
}

/** Agent details from the request headers (`User-Agent: marmot-probe/<version>`, …). */
export function probeAgentInfo(headers: Headers): ProbeAgentInfo {
  const userAgent = headers.get('user-agent') ?? ''
  const version = userAgent.startsWith(PROBE_USER_AGENT_PREFIX)
    ? userAgent.slice(PROBE_USER_AGENT_PREFIX.length).split(/\s/)[0]?.slice(0, 64) || null
    : null
  const clip = (value: string | null, max: number) => value?.trim().slice(0, max) || null
  return {
    version,
    hostname: clip(headers.get(PROBE_HOSTNAME_HEADER), 255),
    platform: clip(headers.get(PROBE_PLATFORM_HEADER), 64),
  }
}

let limiter: RateLimiter | null | undefined

/** Requests per minute per location token (`PROBE_RATE_LIMIT`, `null` when turned off). */
function probeLimiter(): RateLimiter | null {
  if (limiter === undefined) {
    limiter =
      env.PROBE_RATE_LIMIT > 0
        ? createRateLimiter('probe', { points: env.PROBE_RATE_LIMIT, duration: 60 })
        : null
  }
  return limiter
}

/** The location whose token is `token`, or `null` (unknown, rotated or deleted). */
export async function findLocationByToken(
  payload: Payload,
  token: string,
): Promise<Location | null> {
  const { docs } = await payload.find({
    collection: 'locations',
    where: { tokenHash: { equals: hashProbeToken(token) } },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  return (docs[0] as Location | undefined) ?? null
}

/**
 * Stamp `lastSeenAt` (throttled) and the agent's details. `status` is left to the `probe-health`
 * job, the only writer, so status changes and their notices never race.
 */
export async function touchLocation(
  payload: Payload,
  location: Location,
  agent: ProbeAgentInfo,
  now: Date = new Date(),
): Promise<void> {
  const lastSeen = location.lastSeenAt ? new Date(location.lastSeenAt).getTime() : 0
  const agentChanged =
    (agent.version ?? null) !== (location.agent?.version ?? null) ||
    (agent.hostname ?? null) !== (location.agent?.hostname ?? null) ||
    (agent.platform ?? null) !== (location.agent?.platform ?? null)
  if (!agentChanged && now.getTime() - lastSeen < LAST_SEEN_THROTTLE_MS) return
  await payload.update({
    collection: 'locations',
    id: location.id,
    data: { lastSeenAt: now.toISOString(), agent },
    depth: 0,
    overrideAccess: true,
  })
}

export type ProbeAuth = { location: Location; organizationId: Id } | { response: Response }

/**
 * Authenticate a probe request: `Authorization: Bearer mp_…` → its location, rate limited per
 * location (`429` with `Retry-After`), `401` for missing, unknown, rotated or deleted tokens.
 */
export async function authenticateProbe(
  payload: Payload,
  request: Request,
  options: { now?: Date } = {},
): Promise<ProbeAuth> {
  const token = extractProbeToken(request.headers)
  const unauthorized = () =>
    Response.json(
      { error: 'invalid probe token' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="marmot-probe"' } },
    )
  if (!token) return { response: unauthorized() }
  const location = await findLocationByToken(payload, token)
  const organizationId = relationId(location?.organization)
  if (!location || organizationId === null) return { response: unauthorized() }

  const decision = await probeLimiter()?.consume(String(location.id))
  if (decision && !decision.allowed) {
    return {
      response: Response.json(
        { error: 'rate limited' },
        { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } },
      ),
    }
  }

  try {
    await touchLocation(payload, location, probeAgentInfo(request.headers), options.now)
  } catch (err) {
    log.warn({ err, locationId: location.id }, 'failed to stamp lastSeenAt')
  }
  return { location, organizationId }
}

// ---- Configuration ----------------------------------------------------------------------------

/** Server bookkeeping a probe does not need (and that would change the ETag after every beat). */
const OMITTED_MONITOR_FIELDS = [
  'notifications',
  'tags',
  'certInfo',
  'domainExpiry',
  'createdAt',
  'updatedAt',
  'pushToken',
  'parent',
  'weight',
  'description',
  'publicName',
] as const

/**
 * A monitor as a probe receives it: relationships as ids, only `status.lastStatus` kept (on a
 * multi-location monitor, #92, the location's own status: `locationStatus`).
 */
export function toProbeMonitor(
  monitor: Monitor,
  locationStatus?: NonNullable<Monitor['status']>['lastStatus'],
): ProbeMonitor {
  const doc: Record<string, unknown> = { ...monitor }
  for (const field of OMITTED_MONITOR_FIELDS) delete doc[field]
  doc.organization = relationId(monitor.organization)
  doc.proxy = relationId(monitor.proxy)
  doc.dockerHost = relationId(monitor.dockerHost)
  doc.locations = (monitor.locations ?? []).map(relationId)
  doc.status = {
    lastStatus:
      (locationStatus !== undefined ? locationStatus : monitor.status?.lastStatus) ?? null,
  }
  return doc as ProbeMonitor
}

/** Active monitors assigned to the location, oldest first. */
export async function findLocationMonitors(
  payload: Payload,
  location: Pick<Location, 'id' | 'organization'>,
): Promise<Monitor[]> {
  const { docs } = await payload.find({
    collection: 'monitors',
    where: {
      and: [
        { organization: { equals: relationId(location.organization) } },
        { active: { equals: true } },
        { locations: { in: [location.id] } },
      ],
    },
    sort: 'createdAt',
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  return docs as Monitor[]
}

async function resourcesById<T extends { id: Id }>(
  payload: Payload,
  collection: 'proxies' | 'docker-hosts',
  ids: Id[],
  organizationId: Id | null,
): Promise<Record<string, Record<string, unknown>>> {
  if (ids.length === 0) return {}
  const { docs } = await payload.find({
    collection,
    where: { and: [{ id: { in: ids } }, { organization: { equals: organizationId } }] },
    depth: 0,
    limit: ids.length,
    pagination: false,
    overrideAccess: true,
  })
  return Object.fromEntries(
    (docs as unknown as T[]).map((doc) => {
      const { createdAt: _c, updatedAt: _u, ...rest } = doc as T & Record<string, unknown>
      return [String(doc.id), rest]
    }),
  )
}

/**
 * The configuration the location's agents pull, and its ETag (SHA-256 of the body, so an agent
 * that already runs this configuration gets `304 Not Modified`).
 */
export async function buildProbeConfig(
  payload: Payload,
  location: Location,
): Promise<{ config: ProbeConfig; etag: string }> {
  const monitors = await findLocationMonitors(payload, location)
  const organizationId = relationId(location.organization)
  const unique = (values: (Id | null)[]) => [
    ...new Map(
      values.filter((v): v is Id => v !== null).map((v) => [String(v), v] as const),
    ).values(),
  ]
  const [proxies, dockerHosts] = await Promise.all([
    resourcesById<MonitorProxy>(
      payload,
      'proxies',
      unique(monitors.map((m) => relationId(m.proxy))),
      organizationId,
    ),
    resourcesById<DockerHost>(
      payload,
      'docker-hosts',
      unique(monitors.map((m) => relationId(m.dockerHost))),
      organizationId,
    ),
  ])
  // Multi-location monitors (#92): the first cadence follows this location's own state.
  const multi = monitors.filter((monitor) => isMultiLocation(monitor))
  const locationStatuses = new Map<string, NonNullable<Monitor['status']>['lastStatus']>()
  if (multi.length > 0) {
    const { docs } = await payload.find({
      collection: 'monitor-location-states',
      where: {
        and: [
          { monitor: { in: multi.map((monitor) => monitor.id) } },
          { locationKey: { equals: String(location.id) } },
        ],
      },
      select: { monitor: true, lastStatus: true },
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
    })
    for (const doc of docs) locationStatuses.set(String(relationId(doc.monitor)), doc.lastStatus)
  }
  // Agents never check faster than the organization's plan allows (#161; no-op without billing).
  const minInterval = minIntervalResolver(payload)
  const probeMonitors = await Promise.all(
    monitors.map(async (monitor) => {
      const wire = isMultiLocation(monitor)
        ? toProbeMonitor(monitor, locationStatuses.get(String(monitor.id)) ?? null)
        : toProbeMonitor(monitor)
      const floor = await minInterval(relationId(monitor.organization))
      if (floor <= 0) return wire
      return {
        ...wire,
        interval: clampInterval(wire.interval, floor),
        ...(typeof wire.retryInterval === 'number'
          ? { retryInterval: clampInterval(wire.retryInterval, floor) }
          : {}),
      }
    }),
  )
  const config: ProbeConfig = {
    version: 1,
    location: { id: String(location.id), name: location.name, slug: location.slug },
    refreshSeconds: probeRefreshSeconds(),
    monitors: probeMonitors,
    resources: { proxies, dockerHosts },
  }
  const etag = `"${createHash('sha256').update(JSON.stringify(config)).digest('base64url')}"`
  return { config, etag }
}

/** `true` when an `If-None-Match` header names `etag`. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === etag || value === '*')
}

// ---- Settings rows ----------------------------------------------------------------------------

/** Fields the UI receives; `tokenHash` never leaves the server. */
export interface LocationRow {
  id: string
  name: string
  slug: string
  labels: { key: string; value: string | null }[]
  status: LocationStatus
  statusChangedAt: string | null
  lastSeenAt: string | null
  tokenDisplay: string
  tokenRotatedAt: string | null
  agent: ProbeAgentInfo | null
  /** Monitors assigned to the location. */
  monitorCount: number
  createdAt: string
}

export function toLocationRow(doc: Location, monitorCount = 0): LocationRow {
  const agent = doc.agent
  return {
    id: String(doc.id),
    name: doc.name,
    slug: doc.slug,
    labels: (doc.labels ?? []).map((row) => ({ key: row.key, value: row.value ?? null })),
    status: (doc.status ?? 'unknown') as LocationStatus,
    statusChangedAt: doc.statusChangedAt ?? null,
    lastSeenAt: doc.lastSeenAt ?? null,
    tokenDisplay: displayProbeToken(doc.tokenPrefix),
    tokenRotatedAt: doc.tokenRotatedAt ?? null,
    agent:
      agent && (agent.version || agent.hostname || agent.platform)
        ? {
            version: agent.version ?? null,
            hostname: agent.hostname ?? null,
            platform: agent.platform ?? null,
          }
        : null,
    monitorCount,
    createdAt: doc.createdAt,
  }
}

/** Rows of an organization's locations with their monitor counts, sorted by name. */
export async function listLocationRows(
  payload: Payload,
  organizationId: Id,
  access: { user: unknown; overrideAccess: false } | { overrideAccess: true },
): Promise<LocationRow[]> {
  const { docs } = await payload.find({
    collection: 'locations',
    where: { organization: { equals: organizationId } },
    sort: 'name',
    depth: 0,
    limit: 200,
    ...(access as { overrideAccess: boolean }),
    user: 'user' in access ? (access.user as never) : undefined,
  })
  const counts = await Promise.all(
    (docs as Location[]).map(async (doc) => {
      const { totalDocs } = await payload.count({
        collection: 'monitors',
        where: {
          and: [{ organization: { equals: organizationId } }, { locations: { in: [doc.id] } }],
        },
        overrideAccess: true,
      })
      return totalDocs
    }),
  )
  return (docs as Location[]).map((doc, index) => toLocationRow(doc, counts[index]))
}
