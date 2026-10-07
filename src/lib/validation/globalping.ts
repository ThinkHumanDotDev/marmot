/**
 * Globalping monitor options (#142), shared by the form, the zod schema, the collection and the
 * monitor type. Keep this module free of server-only imports: it is bundled into the form.
 *
 * Globalping (https://globalping.io) runs measurements from community-hosted probes; a monitor asks
 * for `globalpingProbes` probes in `globalpingLocations` and judges the result with a success rule.
 */

/** Measurement types a monitor can run. MTR is left out: it adds nothing over traceroute here. */
export const GLOBALPING_MEASUREMENTS = ['ping', 'http', 'dns', 'traceroute'] as const
export type GlobalpingMeasurement = (typeof GLOBALPING_MEASUREMENTS)[number]

/** How many probes must succeed: every probe, one probe, or at least `globalpingMinSuccess`. */
export const GLOBALPING_SUCCESS_RULES = ['all', 'any', 'atLeast'] as const
export type GlobalpingSuccessRule = (typeof GLOBALPING_SUCCESS_RULES)[number]

/** Protocols per measurement, as the Globalping API spells them. */
export const GLOBALPING_PROTOCOLS = {
  ping: ['ICMP', 'TCP'],
  http: ['HTTP', 'HTTPS', 'HTTP2'],
  dns: ['UDP', 'TCP'],
  traceroute: ['ICMP', 'TCP', 'UDP'],
} as const satisfies Record<GlobalpingMeasurement, readonly string[]>

/** Every protocol value the `globalpingProtocol` field accepts (validated per measurement). */
export const GLOBALPING_PROTOCOL_VALUES = ['ICMP', 'TCP', 'UDP', 'HTTP', 'HTTPS', 'HTTP2'] as const
export type GlobalpingProtocol = (typeof GLOBALPING_PROTOCOL_VALUES)[number]

export const GLOBALPING_IP_VERSIONS = ['4', '6'] as const

/** Methods the Globalping HTTP measurement supports (the API refuses the others). */
export const GLOBALPING_HTTP_METHODS = ['HEAD', 'GET', 'OPTIONS'] as const

/** Record types the Globalping DNS measurement supports, among the ones the DNS monitor offers. */
export const GLOBALPING_DNS_RECORD_TYPES = [
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'NS',
  'PTR',
  'SOA',
  'SRV',
  'TXT',
] as const

/** Probes per check. Every probe costs one credit (anonymous: 250 per hour). */
export const GLOBALPING_MAX_PROBES = 50
export const GLOBALPING_DEFAULT_PROBES = 3
/** Ping packets per probe (the API accepts 1–16). */
export const GLOBALPING_MAX_PACKETS = 16
export const GLOBALPING_DEFAULT_PACKETS = 3
/** Longest location list (the API accepts at most 200 locations per measurement). */
export const GLOBALPING_MAX_LOCATIONS = 50

/**
 * Minimum `interval` and `retryInterval` of a Globalping monitor. Checks spend shared community
 * credits: a 3-probe check every minute uses 180 of the 250 anonymous credits per hour.
 */
export const GLOBALPING_MIN_INTERVAL_SECONDS = 60

export const isGlobalpingMeasurement = (value: unknown): value is GlobalpingMeasurement =>
  typeof value === 'string' && (GLOBALPING_MEASUREMENTS as readonly string[]).includes(value)

/** Does `measurement` accept `protocol`? */
export const globalpingProtocolAllowed = (
  measurement: GlobalpingMeasurement,
  protocol: string,
): boolean => (GLOBALPING_PROTOCOLS[measurement] as readonly string[]).includes(protocol)

/**
 * Splits the location text into Globalping "magic" locations: one per comma or line, each in the
 * location DSL (`Europe`, `US+AWS`, `AS13335`, `Frankfurt`). Empty means "anywhere".
 */
export function parseGlobalpingLocations(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Successful probes needed out of `probes` answers. */
export function requiredGlobalpingSuccesses(
  rule: GlobalpingSuccessRule | null | undefined,
  minSuccess: number | null | undefined,
  probes: number,
): number {
  if (rule === 'any') return Math.min(1, probes)
  if (rule === 'atLeast') return Math.max(1, minSuccess ?? 1)
  return probes
}
