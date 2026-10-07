/**
 * Degraded state (#93): a check that succeeds but answers slower than the monitor's `degradedAfter`
 * threshold (ms) is recorded as `degraded`. Shared by the collection, the form and the engine, so it
 * imports nothing server-only.
 */

/**
 * Monitor types whose `ping` is a response time worth a threshold: HTTP(S) (plain, keyword, JSON
 * query), TCP port, ping, DNS and gRPC. The engine ignores `degradedAfter` on every other type, so a
 * value left behind after a type change has no effect.
 */
export const DEGRADED_TYPES = [
  'http',
  'keyword',
  'json-query',
  'port',
  'ping',
  'dns',
  'grpc-keyword',
] as const

export const supportsDegradedThreshold = (type: string | null | undefined): boolean =>
  Boolean(type && (DEGRADED_TYPES as readonly string[]).includes(type))

/**
 * Effective threshold in ms, or `null` when the degraded state is off: no value, `0`, a type
 * without response times (`type` omitted means "any type", for unit tests of the state machine).
 */
export function degradedThresholdMs(monitor: {
  type?: string | null
  degradedAfter?: number | null
}): number | null {
  const value = monitor.degradedAfter
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  if (monitor.type !== undefined && !supportsDegradedThreshold(monitor.type)) return null
  return value
}
