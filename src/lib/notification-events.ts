/**
 * Events a notification channel can subscribe to (#126). Shared by the collection, the dispatcher,
 * the API and the channel form, so it stays free of server imports.
 *
 * The names are stable identifiers (stored on channels, sent as `{{ event }}` to templates, used in
 * exports); add new ones, never rename. Location-specific events (#92) and automatic incidents (#100)
 * extend this list.
 *
 * - `down`: a monitor went DOWN;
 * - `up`: it recovered from DOWN (the message carries the downtime);
 * - `degraded`: it became DEGRADED or went back from DEGRADED to UP (#93);
 * - `reminder`: the `resendInterval` repeat while still DOWN;
 * - `certificate`: TLS certificate and domain expiry warnings;
 * - `maintenance`: a maintenance window of the monitor started or ended.
 */
export const CHANNEL_EVENTS = [
  'down',
  'up',
  'degraded',
  'reminder',
  'certificate',
  'maintenance',
] as const

export type ChannelEvent = (typeof CHANNEL_EVENTS)[number]

/**
 * What a channel receives unless it chooses otherwise: everything that was sent before per-channel
 * filters existed. `degraded` and `maintenance` are opt-in.
 */
export const DEFAULT_CHANNEL_EVENTS: readonly ChannelEvent[] = [
  'down',
  'up',
  'reminder',
  'certificate',
]

export const isChannelEvent = (value: unknown): value is ChannelEvent =>
  typeof value === 'string' && (CHANNEL_EVENTS as readonly string[]).includes(value)

/**
 * A channel's stored selection as a clean list in `CHANNEL_EVENTS` order. Unknown values are
 * dropped; a missing or empty selection means the defaults, which is how channels created before
 * the field existed keep their behaviour (an empty `hasMany` select cannot be told apart from an
 * unset one on Postgres).
 */
export function normalizeChannelEvents(value: unknown): ChannelEvent[] {
  const chosen = new Set(Array.isArray(value) ? value.filter(isChannelEvent) : [])
  if (chosen.size === 0) return [...DEFAULT_CHANNEL_EVENTS]
  return CHANNEL_EVENTS.filter((event) => chosen.has(event))
}
