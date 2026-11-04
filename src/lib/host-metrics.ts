/**
 * Host monitors (#136): the vocabulary shared by the agent, the ingest endpoint, the monitor type,
 * the collection, the form and the detail page. A host agent pushes one sample per interval
 * (`hostSampleSchema`); the server folds it into per-series rollups (`sampleSeries`) and judges the
 * monitor's thresholds against the minutely rollups (`evaluateHostThresholds`). Pure, no server
 * imports.
 */
import { z } from 'zod'

import { legacyGraceMs } from './push-schedule'

// ---- Samples -----------------------------------------------------------------------------------

/** Largest request body the ingest endpoint reads. */
export const HOST_SAMPLE_MAX_BYTES = 256 * 1024
export const HOST_MAX_DISKS = 64
export const HOST_MAX_TEMPERATURES = 64
export const HOST_MAX_CONTAINERS = 200
export const HOST_NAME_MAX_LENGTH = 255

const name = z.string().trim().min(1).max(HOST_NAME_MAX_LENGTH)
const bytes = z.number().finite().min(0).max(1e18)
const percent = z.number().finite().min(0).max(100_000)

export const hostSampleSchema = z.object({
  hostname: name,
  /** `linux`, `darwin`, `win32`, … (`process.platform`). */
  platform: z.string().trim().max(32).nullish(),
  arch: z.string().trim().max(32).nullish(),
  /** Human-readable operating system, e.g. `Ubuntu 24.04.1 LTS` or `Darwin 24.1.0`. */
  os: z.string().trim().max(128).nullish(),
  agentVersion: z.string().trim().max(64).nullish(),
  /** Seconds since boot. */
  uptime: z.number().finite().min(0).nullish(),
  cpus: z.number().int().min(0).max(65_536).nullish(),
  /** Busy share of all cores since the previous sample, in percent. */
  cpu: percent.nullish(),
  /** 1, 5 and 15 minute load averages (not on Windows). */
  load: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).nullish(),
  memory: z.object({ used: bytes, total: bytes }).nullish(),
  swap: z.object({ used: bytes, total: bytes }).nullish(),
  disks: z
    .array(z.object({ mount: name, used: bytes, total: bytes }))
    .max(HOST_MAX_DISKS)
    .nullish(),
  /** Bytes per second received and sent on every interface but loopback. */
  network: z.object({ rx: bytes, tx: bytes }).nullish(),
  temperatures: z
    .array(z.object({ name, celsius: z.number().finite().min(-273).max(1000) }))
    .max(HOST_MAX_TEMPERATURES)
    .nullish(),
  containers: z
    .array(
      z.object({
        name,
        state: z.string().trim().max(32).nullish(),
        cpu: percent.nullish(),
        memoryUsed: bytes.nullish(),
        memoryLimit: bytes.nullish(),
      }),
    )
    .max(HOST_MAX_CONTAINERS)
    .nullish(),
})

export type HostSample = z.infer<typeof hostSampleSchema>

const usedPercent = (part: { used: number; total: number } | null | undefined): number | null =>
  part && part.total > 0 ? Math.min(100, (part.used / part.total) * 100) : null

/**
 * Series keys of a sample and their values: `cpu`, `load1|5|15`, `memory` / `swap` (% used),
 * `disk:<mount>` (% used), `net:rx` / `net:tx` (bytes/s), `temp:<sensor>` (°C) and
 * `docker.cpu:<name>` / `docker.mem:<name>` (% of the container's limit).
 */
export function sampleSeries(sample: HostSample): Record<string, number> {
  const out: Record<string, number> = {}
  const put = (key: string, value: number | null | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  put('cpu', sample.cpu)
  if (sample.load) {
    put('load1', sample.load[0])
    put('load5', sample.load[1])
    put('load15', sample.load[2])
  }
  put('memory', usedPercent(sample.memory))
  put('swap', usedPercent(sample.swap))
  for (const disk of sample.disks ?? []) put(`disk:${disk.mount}`, usedPercent(disk))
  if (sample.network) {
    put('net:rx', sample.network.rx)
    put('net:tx', sample.network.tx)
  }
  for (const sensor of sample.temperatures ?? []) put(`temp:${sensor.name}`, sensor.celsius)
  for (const container of sample.containers ?? []) {
    put(`docker.cpu:${container.name}`, container.cpu)
    if (container.memoryUsed !== null && container.memoryUsed !== undefined) {
      put(
        `docker.mem:${container.name}`,
        usedPercent({ used: container.memoryUsed, total: container.memoryLimit ?? 0 }),
      )
    }
  }
  return out
}

// ---- Rollups -----------------------------------------------------------------------------------

/** Granularities of the `host-metrics` rollups (same buckets and retention as `stat-*`). */
export const HOST_GRANULARITIES = ['minute', 'hour', 'day'] as const
export type HostGranularity = (typeof HOST_GRANULARITIES)[number]

/** One series in one bucket: `[count, sum, min, max, last]`. */
export type HostSeriesAggregate = [number, number, number, number, number]
export type HostSeriesMap = Record<string, HostSeriesAggregate>

export function mergeSeries(into: HostSeriesMap, values: Record<string, number>): HostSeriesMap {
  const out: HostSeriesMap = { ...into }
  for (const [key, value] of Object.entries(values)) {
    const prev = out[key]
    out[key] = prev
      ? [prev[0] + 1, prev[1] + value, Math.min(prev[2], value), Math.max(prev[3], value), value]
      : [1, value, value, value, value]
  }
  return out
}

/** Parse a stored series map, dropping malformed entries. */
export function parseSeriesMap(value: unknown): HostSeriesMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: HostSeriesMap = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      Array.isArray(entry) &&
      entry.length === 5 &&
      entry.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      out[key] = entry as HostSeriesAggregate
    }
  }
  return out
}

// ---- Thresholds --------------------------------------------------------------------------------

export const HOST_METRICS = [
  'cpu',
  'load1',
  'load5',
  'load15',
  'memory',
  'swap',
  'disk',
  'temperature',
  'network-rx',
  'network-tx',
  'container-cpu',
  'container-memory',
] as const
export type HostMetric = (typeof HOST_METRICS)[number]

/** Metrics with several series per host: the threshold's `target` picks one, empty means all. */
export const HOST_TARGETED_METRICS: readonly HostMetric[] = [
  'disk',
  'temperature',
  'container-cpu',
  'container-memory',
]

export const HOST_THRESHOLD_OPERATORS = ['>', '>=', '<', '<='] as const
export type HostThresholdOperator = (typeof HOST_THRESHOLD_OPERATORS)[number]

/** What a breach does to the monitor. */
export const HOST_THRESHOLD_SEVERITIES = ['down', 'degraded'] as const
export type HostThresholdSeverity = (typeof HOST_THRESHOLD_SEVERITIES)[number]

export const HOST_MAX_THRESHOLDS = 25
/** Longest "for" duration of a threshold: the minutely rollups keep 24 hours. */
export const HOST_MAX_THRESHOLD_DURATION = 6 * 3600

export const hostThresholdSchema = z.object({
  metric: z.enum(HOST_METRICS),
  /** Mount point, sensor or container name for the targeted metrics; empty means every one. */
  target: z
    .string()
    .trim()
    .max(HOST_NAME_MAX_LENGTH)
    .nullish()
    .transform((value) => value || null),
  operator: z.enum(HOST_THRESHOLD_OPERATORS).default('>'),
  value: z.number().finite(),
  /** Seconds the condition must hold before it counts (0 = the latest sample decides). */
  duration: z.number().int().min(0).max(HOST_MAX_THRESHOLD_DURATION).default(0),
  severity: z.enum(HOST_THRESHOLD_SEVERITIES).default('down'),
})
export type HostThreshold = z.infer<typeof hostThresholdSchema>

export const hostThresholdsSchema = z.array(hostThresholdSchema).max(HOST_MAX_THRESHOLDS)

/** Thresholds a new host monitor starts with: any disk over 90 % is DOWN, sustained load degrades. */
export const DEFAULT_HOST_THRESHOLDS: readonly HostThreshold[] = [
  { metric: 'disk', target: null, operator: '>', value: 90, duration: 0, severity: 'down' },
  { metric: 'cpu', target: null, operator: '>', value: 90, duration: 300, severity: 'degraded' },
  { metric: 'memory', target: null, operator: '>', value: 90, duration: 300, severity: 'degraded' },
]

/** Parse stored thresholds leniently: malformed rows are skipped. */
export function parseHostThresholds(value: unknown): HostThreshold[] {
  if (!Array.isArray(value)) return []
  const out: HostThreshold[] = []
  for (const row of value) {
    const parsed = hostThresholdSchema.safeParse(row)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/** Series key prefix (targeted metrics) or exact key of a metric. */
const METRIC_KEYS: Record<HostMetric, { key: string; prefix: boolean }> = {
  cpu: { key: 'cpu', prefix: false },
  load1: { key: 'load1', prefix: false },
  load5: { key: 'load5', prefix: false },
  load15: { key: 'load15', prefix: false },
  memory: { key: 'memory', prefix: false },
  swap: { key: 'swap', prefix: false },
  disk: { key: 'disk:', prefix: true },
  temperature: { key: 'temp:', prefix: true },
  'network-rx': { key: 'net:rx', prefix: false },
  'network-tx': { key: 'net:tx', prefix: false },
  'container-cpu': { key: 'docker.cpu:', prefix: true },
  'container-memory': { key: 'docker.mem:', prefix: true },
}

/** The series keys among `keys` a threshold applies to. */
export function thresholdSeriesKeys(threshold: HostThreshold, keys: Iterable<string>): string[] {
  const spec = METRIC_KEYS[threshold.metric]
  const out: string[] = []
  for (const key of keys) {
    if (!spec.prefix) {
      if (key === spec.key) out.push(key)
    } else if (key.startsWith(spec.key)) {
      const target = key.slice(spec.key.length)
      if (!threshold.target || target === threshold.target) out.push(key)
    }
  }
  return out
}

export function compareThreshold(value: number, operator: HostThresholdOperator, limit: number) {
  switch (operator) {
    case '>':
      return value > limit
    case '>=':
      return value >= limit
    case '<':
      return value < limit
    case '<=':
      return value <= limit
  }
}

/** A minutely rollup row as the evaluation reads it. */
export interface HostRollupRow {
  /** Unix seconds of the bucket start. */
  timestamp: number
  series: HostSeriesMap
}

export interface HostBreach {
  threshold: HostThreshold
  key: string
  value: number
}

export interface HostVerdict {
  status: 'up' | 'degraded' | 'down'
  breaches: HostBreach[]
}

const BUCKET_MS = 60_000

/**
 * Judge the thresholds against the minutely rollups (`rows`, any order). A threshold breaches
 * when the newest value of a series meets it and, with a `duration`, every sample of the last
 * `duration` seconds met it too (judged per minute bucket on its min or max, so one sample on the
 * healthy side clears it) and the series reaches back at least that far. `intervalSeconds`, the
 * agent's push interval, lets a slow agent's previous sample count as the window's start.
 */
export function evaluateHostThresholds(
  thresholds: readonly HostThreshold[],
  rows: readonly HostRollupRow[],
  now: Date,
  intervalSeconds = 60,
): HostVerdict {
  const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp)
  // Only the series the newest sample still reports: an unmounted disk or a removed container
  // stops counting at once.
  const latestKeys = Object.keys(sorted.at(-1)?.series ?? {})
  const breaches: HostBreach[] = []

  for (const threshold of thresholds) {
    const lower = threshold.operator === '<' || threshold.operator === '<='
    let worst: HostBreach | null = null
    for (const key of thresholdSeriesKeys(threshold, latestKeys)) {
      const withKey = sorted.filter((row) => row.series[key])
      const newest = withKey.at(-1)
      if (!newest) continue
      const last = newest.series[key][4]
      if (!compareThreshold(last, threshold.operator, threshold.value)) continue
      if (threshold.duration > 0) {
        const windowStart = now.getTime() - threshold.duration * 1000
        const lookBack = windowStart - intervalSeconds * 1000
        const relevant = withKey.filter((row) => row.timestamp * 1000 + BUCKET_MS > lookBack)
        if (relevant.length === 0 || relevant[0].timestamp * 1000 > windowStart) continue
        const sustained = relevant.every((row) => {
          const [, , min, max] = row.series[key]
          return compareThreshold(lower ? max : min, threshold.operator, threshold.value)
        })
        if (!sustained) continue
      }
      const further = worst === null || (lower ? last < worst.value : last > worst.value)
      if (further) worst = { threshold, key, value: last }
    }
    if (worst) breaches.push(worst)
  }

  const status = breaches.some((b) => b.threshold.severity === 'down')
    ? 'down'
    : breaches.length > 0
      ? 'degraded'
      : 'up'
  return { status, breaches }
}

/**
 * Grace in ms after the interval before a silent agent counts as DOWN: `pushGrace` when set,
 * otherwise 10 % of the interval, like push monitors.
 */
export function hostGraceMs(monitor: { interval: number; pushGrace?: number | null }): number {
  return typeof monitor.pushGrace === 'number' && monitor.pushGrace >= 0
    ? monitor.pushGrace * 1000
    : legacyGraceMs(monitor.interval)
}

// ---- Messages ----------------------------------------------------------------------------------

/** Unit of a series: `%`, `°C`, `B/s` or none (load). */
export function seriesUnit(key: string): '%' | '°C' | 'B/s' | '' {
  if (key.startsWith('temp:')) return '°C'
  if (key.startsWith('net:')) return 'B/s'
  if (key.startsWith('load')) return ''
  return '%'
}

/** English label of a series for heartbeat messages, e.g. `disk /` or `container web memory`. */
export function seriesLabel(key: string): string {
  if (key === 'cpu') return 'CPU'
  if (key === 'memory') return 'memory'
  if (key === 'swap') return 'swap'
  if (key.startsWith('load')) return `load (${key.slice(4)} min)`
  if (key === 'net:rx') return 'network in'
  if (key === 'net:tx') return 'network out'
  if (key.startsWith('disk:')) return `disk ${key.slice(5)}`
  if (key.startsWith('temp:')) return `temperature ${key.slice(5)}`
  if (key.startsWith('docker.cpu:')) return `container ${key.slice(11)} CPU`
  if (key.startsWith('docker.mem:')) return `container ${key.slice(11)} memory`
  return key
}

/** Format a byte rate with binary units: `1.5 MiB/s`. */
export function formatRate(bytesPerSecond: number): string {
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s']
  let value = bytesPerSecond
  let unit = 0
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** A series value with its unit, for heartbeat messages: `93 %`, `71.5 °C`, `2.31`. */
export function formatSeriesValue(key: string, value: number): string {
  const unit = seriesUnit(key)
  if (unit === 'B/s') return formatRate(value)
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 100) / 100
  return unit ? `${rounded} ${unit}` : String(rounded)
}

const formatDuration = (seconds: number): string =>
  seconds % 3600 === 0
    ? `${seconds / 3600} h`
    : seconds % 60 === 0
      ? `${seconds / 60} min`
      : `${seconds} s`

/** `disk / at 93 % (> 90 %)`, `CPU at 97 % for 5 min (> 90 %)`. */
export function describeBreach(breach: HostBreach): string {
  const { key, value, threshold } = breach
  const sustained = threshold.duration > 0 ? ` for ${formatDuration(threshold.duration)}` : ''
  return `${seriesLabel(key)} at ${formatSeriesValue(key, value)}${sustained} (${
    threshold.operator
  } ${formatSeriesValue(key, threshold.value)})`
}

/** Heartbeat message of a healthy host: `CPU 12 %, memory 48 %, disk / 61 %`. */
export function describeHealthy(latest: Record<string, number>): string {
  const parts: string[] = []
  for (const key of ['cpu', 'memory']) {
    if (latest[key] !== undefined)
      parts.push(`${seriesLabel(key)} ${formatSeriesValue(key, latest[key])}`)
  }
  const disks = Object.keys(latest).filter((key) => key.startsWith('disk:'))
  if (disks.length > 0) {
    const fullest = disks.reduce((a, b) => (latest[b] > latest[a] ? b : a))
    parts.push(`${seriesLabel(fullest)} ${formatSeriesValue(fullest, latest[fullest])}`)
  }
  return parts.length > 0 ? parts.join(', ') : 'Metrics received'
}
