/**
 * Probe locations (#91): where a monitor is checked from. Shared by the collections, the engine,
 * the probe agent and the UI, so it imports nothing from the server.
 *
 * A monitor without `locations` is checked by the instance's own worker pool, the implicit
 * location `local`. A monitor assigned to remote locations is checked by the probe agents of those
 * locations (and by the local workers too when `includeLocal` is set); its heartbeats carry the
 * location's id. A monitor checked from more than one location (#92) keeps a state per location
 * and derives its own status by quorum (`src/server/engine/quorum.ts`).
 */

/** Id of the implicit location: the worker pool of the Marmot instance itself. */
export const LOCAL_LOCATION = 'local'

/** Remote locations per monitor (the local worker pool comes on top). */
export const MAX_MONITOR_LOCATIONS = 10

/**
 * How many of a monitor's locations must agree before the monitor changes status (#92):
 * `any` one of them, at least `half` of them (the default) or `all` of them.
 */
export const QUORUM_MODES = ['any', 'half', 'all'] as const
export type QuorumMode = (typeof QUORUM_MODES)[number]
export const DEFAULT_QUORUM: QuorumMode = 'half'

export const isQuorumMode = (value: unknown): value is QuorumMode =>
  typeof value === 'string' && (QUORUM_MODES as readonly string[]).includes(value)

/** Locations that must report a status for the monitor to take it, out of `total`. */
export function quorumNeeded(mode: QuorumMode | null | undefined, total: number): number {
  const n = Math.max(1, Math.floor(total))
  if (mode === 'any') return 1
  if (mode === 'all') return n
  return Math.ceil(n / 2)
}

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
 * requests that reach the server, `steam` needs the instance's Steam API key, and `globalping`
 * only calls the Globalping API (whose probes are the vantage points) with the instance's token.
 */
export const PROBE_UNSUPPORTED_TYPES: readonly string[] = [
  'group',
  'manual',
  'push',
  'steam',
  'globalping',
]

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

type LocatedMonitor = { locations?: unknown; includeLocal?: boolean | null } | null | undefined

/** `true` when the local worker pool checks the monitor (no remote location, or `includeLocal`). */
export const checksLocally = (monitor: LocatedMonitor): boolean =>
  monitorLocationIds(monitor).length === 0 || monitor?.includeLocal === true

/** `true` when only probe agents check the monitor, never the local worker pool. */
export const isRemoteMonitor = (monitor: LocatedMonitor): boolean => !checksLocally(monitor)

/**
 * Location keys a monitor is checked from: the remote locations' ids (as strings) plus `local`
 * when the worker pool checks it too. Never empty.
 */
export function monitorLocationKeys(monitor: LocatedMonitor): string[] {
  const keys = [...new Set(monitorLocationIds(monitor).map(String))]
  if (checksLocally(monitor)) keys.push(LOCAL_LOCATION)
  return keys
}

/** `true` when the monitor is checked from several locations and its status is a quorum (#92). */
export const isMultiLocation = (monitor: LocatedMonitor): boolean =>
  monitorLocationKeys(monitor).length > 1

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
