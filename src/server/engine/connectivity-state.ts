/**
 * Shared view of the workers' self connectivity check (#148). Every worker publishes its verdict
 * to Redis after each probe (`marmot:connectivity:status:<location>:<worker>`, expiring after a few
 * intervals so a stopped worker disappears); the web process reads them for `/api/health`,
 * `/api/metrics` and the "checker offline" banner. Never throws: Redis trouble reads as `unknown`.
 */
import type { Redis } from 'ioredis'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { createRedis } from '@/server/redis'
import type { ConnectivitySnapshot, ConnectivityStatus } from './connectivity'

const log = childLogger('engine:connectivity-state')

export const CHECKER_STATE_PREFIX = 'marmot:connectivity:status:'

/** One worker's published verdict. */
export interface CheckerState {
  location: string
  worker: string
  status: ConnectivityStatus
  since: string | null
  checkedAt: string | null
}

/** Status of the instance's checkers as a whole. */
export type CheckerSummaryStatus = ConnectivityStatus | 'disabled'

export interface CheckerSummary {
  /**
   * `disabled` when the check is off, `unknown` when no worker reported, `offline` when any worker
   * is offline, `online` otherwise.
   */
  status: CheckerSummaryStatus
  /** Start of the earliest current outage (ISO) while `offline`, else `null`. */
  since: string | null
  locations: { location: string; status: ConnectivityStatus; since: string | null }[]
}

export interface CheckerStateOptions {
  redis?: Redis
  /** Key prefix (tests use a unique one). */
  prefix?: string
}

let client: Redis | undefined

const getClient = (): Redis => {
  client ??= createRedis({ maxRetriesPerRequest: 1, commandTimeout: 1_000 })
  return client
}

/** Close the shared connection (tests, graceful shutdown). */
export async function closeCheckerStateStore(): Promise<void> {
  const current = client
  client = undefined
  if (current) await current.quit().catch(() => undefined)
}

/** Publish a worker's verdict; it expires after `ttlSeconds`. */
export async function publishCheckerState(
  snapshot: ConnectivitySnapshot,
  worker: string,
  ttlSeconds: number,
  options: CheckerStateOptions = {},
): Promise<void> {
  const state: CheckerState = {
    location: snapshot.location,
    worker,
    status: snapshot.status,
    since: snapshot.since,
    checkedAt: snapshot.checkedAt,
  }
  const key = `${options.prefix ?? CHECKER_STATE_PREFIX}${snapshot.location}:${worker}`
  await (options.redis ?? getClient()).set(key, JSON.stringify(state), 'EX', ttlSeconds)
}

/** Every published verdict. */
export async function readCheckerStates(
  options: CheckerStateOptions = {},
): Promise<CheckerState[]> {
  const redis = options.redis ?? getClient()
  const prefix = options.prefix ?? CHECKER_STATE_PREFIX
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0')
  if (keys.length === 0) return []
  const values = await redis.mget(...keys)
  const states: CheckerState[] = []
  for (const value of values) {
    if (!value) continue
    try {
      states.push(JSON.parse(value) as CheckerState)
    } catch {
      // A malformed entry is skipped; it expires on its own.
    }
  }
  return states
}

/** Fold the workers' verdicts into one status per location and one for the instance. */
export function summarizeCheckerStates(states: readonly CheckerState[]): CheckerSummary {
  const byLocation = new Map<string, CheckerState[]>()
  for (const state of states) {
    const list = byLocation.get(state.location) ?? []
    list.push(state)
    byLocation.set(state.location, list)
  }
  const earliest = (list: readonly CheckerState[]) =>
    list
      .map((s) => s.since)
      .filter((s): s is string => Boolean(s))
      .sort()[0] ?? null

  const locations = [...byLocation.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([location, list]) => {
      const offline = list.filter((s) => s.status === 'offline')
      if (offline.length > 0)
        return { location, status: 'offline' as const, since: earliest(offline) }
      const online = list.filter((s) => s.status === 'online')
      if (online.length > 0) return { location, status: 'online' as const, since: earliest(online) }
      return { location, status: 'unknown' as const, since: null }
    })

  const offline = locations.filter((l) => l.status === 'offline')
  if (offline.length > 0) {
    return {
      status: 'offline',
      since:
        offline
          .map((l) => l.since)
          .filter((s): s is string => Boolean(s))
          .sort()[0] ?? null,
      locations,
    }
  }
  const status = locations.some((l) => l.status === 'online') ? 'online' : 'unknown'
  return { status, since: null, locations }
}

/** The instance's checker status for the health endpoint, metrics and the UI. Never throws. */
export async function getCheckerSummary(
  options: CheckerStateOptions = {},
): Promise<CheckerSummary> {
  if (!env.CONNECTIVITY_CHECK_ENABLED) return { status: 'disabled', since: null, locations: [] }
  try {
    return summarizeCheckerStates(await readCheckerStates(options))
  } catch (err) {
    log.warn({ err }, 'cannot read the checker status')
    return { status: 'unknown', since: null, locations: [] }
  }
}
