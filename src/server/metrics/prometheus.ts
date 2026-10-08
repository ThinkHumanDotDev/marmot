/**
 * Prometheus metrics for `GET /api/metrics`.
 *
 * Unlike Uptime Kuma, which keeps one process-wide registry updated after every beat, Marmot's web
 * process is stateless: every scrape builds a fresh `prom-client` registry from the Local API for
 * the organization the API key belongs to. Metric names and labels follow Uptime Kuma 2.5.5
 * `server/prometheus.js` (MIT, Louis Lam) so existing dashboards keep working.
 */
import { Gauge, Registry } from 'prom-client'
import type { Payload } from 'payload'

import type { Monitor } from '@/payload-types'
import { getCheckerSummary, type CheckerSummary } from '@/server/engine/connectivity-state'
import {
  PERCENTILE_VALUES,
  PERCENTILES,
  type PercentileValues,
} from '@/server/stats/latency-histogram'
import { bucketPercentiles } from '@/server/stats/range-stats'
import { getBuckets, getUptime, type StatsRange } from '@/server/stats/uptime-calculator'

export const MONITOR_LABELS = [
  'monitor_id',
  'monitor_name',
  'monitor_type',
  'monitor_url',
  'monitor_hostname',
  'monitor_port',
] as const
export type MonitorLabel = (typeof MONITOR_LABELS)[number]

/** Kuma's status numbers: 1 UP, 0 DOWN, 2 PENDING, 3 MAINTENANCE; Marmot adds 4 DEGRADED (#93). */
export const STATUS_VALUES: Record<NonNullable<Monitor['status']>['lastStatus'] & string, number> =
  {
    up: 1,
    down: 0,
    pending: 2,
    maintenance: 3,
    degraded: 4,
  }

export const UPTIME_WINDOWS: readonly StatsRange[] = ['24h', '30d']

export type MonitorLabelValues = Record<MonitorLabel, string>

export function monitorLabelValues(monitor: Monitor): MonitorLabelValues {
  return {
    monitor_id: String(monitor.id),
    monitor_name: monitor.name ?? '',
    monitor_type: monitor.type ?? '',
    monitor_url: monitor.url ?? '',
    monitor_hostname: monitor.hostname ?? '',
    monitor_port: monitor.port === null || monitor.port === undefined ? '' : String(monitor.port),
  }
}

/**
 * Certificate information as the cert-expiry job (#24) will store it on `monitors.certInfo`. The
 * field does not exist yet; both the flat and Kuma's nested `tlsInfo` shapes are accepted.
 */
export interface MonitorCertInfo {
  valid: boolean
  daysRemaining: number | null
  validTo: string | null
}

export function readCertInfo(monitor: Monitor): MonitorCertInfo | null {
  const raw = (monitor as Monitor & { certInfo?: unknown }).certInfo
  if (!raw || typeof raw !== 'object') return null
  const info = raw as {
    valid?: unknown
    daysRemaining?: unknown
    validTo?: unknown
    certInfo?: { daysRemaining?: unknown; validTo?: unknown }
  }
  const days = info.daysRemaining ?? info.certInfo?.daysRemaining
  const validTo = info.validTo ?? info.certInfo?.validTo
  return {
    valid: info.valid === true,
    daysRemaining: typeof days === 'number' && Number.isFinite(days) ? days : null,
    validTo: typeof validTo === 'string' ? validTo : null,
  }
}

export interface MetricsSource {
  monitors: Monitor[]
  /** Uptime ratio per monitor id and window; missing entries are skipped. */
  uptime: Map<string, Partial<Record<StatsRange, number>>>
  /** Self connectivity check of the workers (#148); omitted when disabled. */
  checker?: CheckerSummary
  /**
   * Response-time percentiles per monitor id and window (#95). The `monitor_response_time_quantile`
   * gauge is only registered when this is set (`/api/metrics?quantiles=true`).
   */
  quantiles?: Map<string, Partial<Record<StatsRange, Partial<PercentileValues>>>>
}

/** Build a registry from already loaded data (pure; tests call this directly). */
export function buildRegistry(source: MetricsSource): Registry {
  const registry = new Registry()
  const labelNames = [...MONITOR_LABELS]

  const status = new Gauge({
    name: 'monitor_status',
    help: 'Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE, 4= DEGRADED)',
    labelNames,
    registers: [registry],
  })
  const responseTime = new Gauge({
    name: 'monitor_response_time',
    help: 'Monitor Response Time (ms)',
    labelNames,
    registers: [registry],
  })
  const uptimeRatio = new Gauge({
    name: 'monitor_uptime_ratio',
    help: "Uptime ratio calculated over sliding window specified by the 'window' label. (0.0 - 1.0)",
    labelNames: [...labelNames, 'window'],
    registers: [registry],
  })
  const certDays = new Gauge({
    name: 'monitor_cert_days_remaining',
    help: 'The number of days remaining until the certificate expires',
    labelNames,
    registers: [registry],
  })
  const certValid = new Gauge({
    name: 'monitor_cert_is_valid',
    help: 'Is the certificate still valid? (1 = Yes, 0= No)',
    labelNames,
    registers: [registry],
  })

  const quantile = source.quantiles
    ? new Gauge({
        name: 'monitor_response_time_quantile',
        help: "Response time (ms) quantile over the sliding window specified by the 'window' label",
        labelNames: [...labelNames, 'window', 'quantile'],
        registers: [registry],
      })
    : null

  if (source.checker && source.checker.status !== 'disabled') {
    const checkerOnline = new Gauge({
      name: 'marmot_checker_online',
      help: 'Self connectivity check of the worker location (1 = online, 0 = offline: external checks are held)',
      labelNames: ['location'],
      registers: [registry],
    })
    for (const { location, status } of source.checker.locations) {
      if (status !== 'unknown') checkerOnline.set({ location }, status === 'online' ? 1 : 0)
    }
  }

  for (const monitor of source.monitors) {
    const labels = monitorLabelValues(monitor)
    const lastStatus = monitor.status?.lastStatus
    if (lastStatus && lastStatus in STATUS_VALUES) {
      status.set(labels, STATUS_VALUES[lastStatus])
    }
    const ping = monitor.status?.lastPing
    // Kuma reports -1 when the last beat carried no ping.
    responseTime.set(labels, typeof ping === 'number' && Number.isFinite(ping) ? ping : -1)

    const windows = source.uptime.get(String(monitor.id))
    for (const window of UPTIME_WINDOWS) {
      const ratio = windows?.[window]
      if (typeof ratio === 'number' && Number.isFinite(ratio)) {
        uptimeRatio.set({ ...labels, window }, ratio)
      }
    }

    const monitorQuantiles = source.quantiles?.get(String(monitor.id))
    for (const window of UPTIME_WINDOWS) {
      const values = monitorQuantiles?.[window]
      for (const key of PERCENTILES) {
        const value = values?.[key]
        if (quantile && typeof value === 'number' && Number.isFinite(value)) {
          quantile.set({ ...labels, window, quantile: String(PERCENTILE_VALUES[key] / 100) }, value)
        }
      }
    }

    const cert = readCertInfo(monitor)
    if (cert) {
      certValid.set(labels, cert.valid ? 1 : 0)
      if (cert.daysRemaining !== null) certDays.set(labels, cert.daysRemaining)
    }
  }

  return registry
}

export type CollectMetricsOptions = {
  /** Also export `monitor_response_time_quantile` (reads the stat rollups' histograms). */
  quantiles?: boolean
}

/** Load the organization's monitors and their uptime windows, then build the registry. */
export async function collectOrganizationMetrics(
  payload: Payload,
  organizationId: string | number,
  options: CollectMetricsOptions = {},
): Promise<Registry> {
  const { docs } = await payload.find({
    collection: 'monitors',
    where: { organization: { equals: organizationId } },
    depth: 0,
    limit: 0,
    pagination: false,
    sort: 'name',
    overrideAccess: true,
  })
  const monitors = docs as Monitor[]

  const uptime = new Map<string, Partial<Record<StatsRange, number>>>()
  await Promise.all(
    monitors.map(async (monitor) => {
      const windows: Partial<Record<StatsRange, number>> = {}
      for (const window of UPTIME_WINDOWS) {
        try {
          windows[window] = await getUptime(payload, monitor.id, window)
        } catch {
          // No stats yet for this monitor/window: skip the sample rather than fail the scrape.
        }
      }
      uptime.set(String(monitor.id), windows)
    }),
  )

  let quantiles: MetricsSource['quantiles']
  if (options.quantiles) {
    const collected: NonNullable<MetricsSource['quantiles']> = new Map()
    await Promise.all(
      monitors.map(async (monitor) => {
        const windows: Partial<Record<StatsRange, Partial<PercentileValues>>> = {}
        for (const window of UPTIME_WINDOWS) {
          try {
            windows[window] = bucketPercentiles(await getBuckets(payload, monitor.id, window))
          } catch {
            // Same as uptime: skip the sample rather than fail the scrape.
          }
        }
        collected.set(String(monitor.id), windows)
      }),
    )
    quantiles = collected
  }

  return buildRegistry({ monitors, uptime, quantiles, checker: await getCheckerSummary() })
}
