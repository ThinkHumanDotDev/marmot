/**
 * Probe locations (#91): where a monitor is checked from. Shared by the collections, the engine,
 * the probe agent and the UI, so it imports nothing from the server.
 *
 * A monitor without `locations` is checked by the instance's own worker pool, the implicit
 * location `local`. A monitor assigned to a remote location is checked only by the probe agents
 * of that location; its heartbeats carry the location's id. Until multi-location quorum (#92)
 * exists a monitor has at most one location (`MAX_MONITOR_LOCATIONS`), so its single state
 * machine never interleaves results from two vantage points.
 */

/** Id of the implicit location: the worker pool of the Marmot instance itself. */
export const LOCAL_LOCATION = 'local'

/** Locations per monitor until multi-location quorum (#92) lifts the limit. */
export const MAX_MONITOR_LOCATIONS = 1

/** Metadata labels per location (`region: eu-west`). */
export const MAX_LOCATION_LABELS = 20

/**
 * `unknown`: no probe connected yet; `online`: a probe called in within `PROBE_OFFLINE_AFTER`
 * seconds; `offline`: it stopped calling in. Derived from `lastSeenAt` by the worker's
 * `probe-health` job, the only writer.
 */
export const LOCATION_STATUSES = ['unknown', 'online', 'offline'] as const
export type LocationStatus = (typeof LOCATION_STATUSES)[number]

/**
 * Types a probe cannot run: `group` and `manual` are computed by the server, `push` waits for
 * requests that reach the server, and `steam` needs the instance's Steam API key.
 */
export const PROBE_UNSUPPORTED_TYPES: readonly string[] = ['group', 'manual', 'push', 'steam']

export const probeSupportsType = (type: string | null | undefined): boolean =>
  Boolean(type) && !PROBE_UNSUPPORTED_TYPES.includes(type as string)

type Id = string | number

const idOf = (value: unknown): Id | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/** Ids of the remote locations assigned to a monitor (empty: the local worker pool). */
export function monitorLocationIds(monitor: { locations?: unknown } | null | undefined): Id[] {
  const value = monitor?.locations
  if (!Array.isArray(value)) return []
  return value.map(idOf).filter((id): id is Id => id !== null)
}

/** `true` when the monitor is checked by a probe agent instead of the local worker pool. */
export const isRemoteMonitor = (monitor: { locations?: unknown } | null | undefined): boolean =>
  monitorLocationIds(monitor).length > 0

/** Location key of a heartbeat: the location's id, or `local` for the worker pool. */
export const heartbeatLocationKey = (location: unknown): string => {
  const id = idOf(location)
  return id === null ? LOCAL_LOCATION : String(id)
}

/** Lower-case slug from a name (`Office Berlin` → `office-berlin`). */
export function locationSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export const LOCATION_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/
