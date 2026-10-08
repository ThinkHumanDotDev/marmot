/**
 * OpenTelemetry metrics export (#99): the heartbeat listener that turns every check into OTLP data
 * points (`./metrics.ts`) and hands them to the collector's batching exporter (`./exporter.ts`).
 *
 * Registered by the worker at boot and by the web process's beat pipeline (push monitors, probe
 * results). One exporter per collector and process is reused for every check; a collector whose
 * URL or headers change gets a new one (the old one is flushed first). Export failures are logged
 * and recorded on the collector (`lastError`) and never affect the check: the listener only
 * queues, the HTTP request happens later.
 */
import os from 'node:os'

import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { OTEL_SERVICE_NAME } from '@/lib/otel'
import { LOCAL_LOCATION, heartbeatLocationKey } from '@/lib/probe-locations'
import type { RequestTiming } from '@/lib/request-timing'
import { MARMOT_VERSION } from '@/lib/version'
import type { OtelCollector } from '@/payload-types'
import { registerHeartbeatListener, type HeartbeatEvent } from '@/server/engine/hooks'

import { metricsUrl } from './endpoint'
import { OtelExporter, type ExportResult } from './exporter'
import { openHeaders } from './headers'
import { checkPoints, type CheckSample, type ErrorSeries } from './metrics'
import { resolveCollector } from './resolve'

const log = childLogger('otel')

/** Distinguishes this process's cumulative counters from another replica's. */
const INSTANCE_ID = `${os.hostname()}:${process.pid}`

/** Collector bookkeeping (`lastExportAt`) is written at most this often while exports succeed. */
const BOOKKEEPING_INTERVAL_MS = 60_000

const exporters = new Map<string, { exporter: OtelExporter; signature: string }>()
const errorSeries = new Map<string, ErrorSeries>()
const bookkeeping = new Map<string, { writtenAt: number; error: string | null }>()
const locationNames = new Map<string, { name: string; expiresAt: number }>()

const SUCCESS = new Set(['up', 'degraded'])

async function recordOutcome(
  payload: Payload,
  collectorId: string | number,
  result: ExportResult,
): Promise<void> {
  const key = String(collectorId)
  const error = result.ok ? null : (result.error ?? 'export failed').slice(0, 500)
  const previous = bookkeeping.get(key)
  const now = Date.now()
  if (previous && previous.error === error && now - previous.writtenAt < BOOKKEEPING_INTERVAL_MS) {
    return
  }
  bookkeeping.set(key, { writtenAt: now, error })
  await payload
    .update({
      collection: 'otel-collectors',
      id: collectorId,
      data: {
        ...(result.ok ? { lastExportAt: new Date(now).toISOString() } : {}),
        lastError: error,
      },
      depth: 0,
      overrideAccess: true,
    })
    .catch((err: unknown) => {
      // The collector may have been deleted meanwhile.
      log.debug({ err, collector: key }, 'could not record the OTLP export outcome')
    })
}

function exporterFor(payload: Payload, collector: OtelCollector): OtelExporter {
  const key = String(collector.id)
  const signature = `${collector.endpoint}\n${collector.headers ?? ''}`
  const current = exporters.get(key)
  if (current?.signature === signature) return current.exporter
  if (current) void current.exporter.close()

  const exporter = new OtelExporter(
    {
      id: key,
      url: metricsUrl(collector.endpoint),
      headers: openHeaders(collector.headers),
      resource: {
        'service.name': OTEL_SERVICE_NAME,
        'service.version': MARMOT_VERSION,
        'service.instance.id': INSTANCE_ID,
        'marmot.organization.id': String(
          typeof collector.organization === 'object'
            ? collector.organization.id
            : collector.organization,
        ),
      },
    },
    {
      intervalMs: env.OTLP_EXPORT_INTERVAL_MS,
      maxBatch: env.OTLP_EXPORT_MAX_BATCH,
      maxQueue: env.OTLP_EXPORT_MAX_QUEUE,
      timeoutMs: env.OTLP_EXPORT_TIMEOUT_MS,
      onResult: (result) => recordOutcome(payload, collector.id, result),
    },
  )
  exporters.set(key, { exporter, signature })
  return exporter
}

/** `local`, or the probe location's slug (cached; its id when the location is gone). */
async function locationName(payload: Payload, key: string): Promise<string> {
  if (key === LOCAL_LOCATION) return key
  const cached = locationNames.get(key)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.name
  const doc = await payload
    .findByID({ collection: 'locations', id: key, depth: 0, overrideAccess: true })
    .catch(() => null)
  const name = doc?.slug || key
  locationNames.set(key, { name, expiresAt: now + 5 * 60_000 })
  return name
}

/** Whether the check behind a beat succeeded (a "Recovering n/N" PENDING beat did). */
export function checkSucceeded(event: HeartbeatEvent): boolean {
  if (event.location) return SUCCESS.has(event.location.status)
  const status = event.heartbeat.status
  if (SUCCESS.has(status)) return true
  return status === 'pending' && (event.monitor.status?.recoveries ?? 0) > 0
}

/** The data points of a beat, or `null` for beats that are not checks. */
export async function sampleFromEvent(
  payload: Payload,
  event: HeartbeatEvent,
): Promise<CheckSample | null> {
  // Held, deferred and repair beats ran no check; maintenance beats skip the check.
  if (event.checkerOffline || event.deferred || event.repair) return null
  if (event.heartbeat.status === 'maintenance') return null
  const { heartbeat, monitor } = event
  const key = event.location?.key ?? heartbeatLocationKey(heartbeat.location)
  return {
    monitor,
    time: new Date(heartbeat.time).getTime(),
    location: await locationName(payload, key),
    ok: checkSucceeded(event),
    ping: heartbeat.ping ?? null,
    timing: (heartbeat.timing as Partial<RequestTiming> | null | undefined) ?? null,
    statusCode: heartbeat.statusCode ?? null,
  }
}

function nextErrorSeries(sample: CheckSample): ErrorSeries {
  const key = `${String(sample.monitor.id)}\n${sample.location}`
  let series = errorSeries.get(key)
  if (!series) {
    series = { startTime: sample.time, value: 0 }
    errorSeries.set(key, series)
  }
  if (!sample.ok) series.value += 1
  return { ...series }
}

export async function exportHeartbeat(payload: Payload, event: HeartbeatEvent): Promise<boolean> {
  if (!env.OTLP_EXPORT_ENABLED) return false
  const organizationId = event.organizationId
  if (organizationId === null || organizationId === undefined) return false
  const collector = await resolveCollector(payload, organizationId, event.monitor)
  if (!collector) return false
  const sample = await sampleFromEvent(payload, event)
  if (!sample) return false
  exporterFor(payload, collector).enqueue(checkPoints(sample, nextErrorSeries(sample)))
  return true
}

let unsubscribe: (() => void) | null = null

/** Registers the export listener once per process. */
export function registerOtelListener(payload: Payload): void {
  if (unsubscribe) return
  unsubscribe = registerHeartbeatListener(async (event) => {
    try {
      await exportHeartbeat(payload, event)
    } catch (err) {
      log.error({ err, monitorId: event.monitor.id }, 'OTLP export of a heartbeat failed')
    }
  })
}

/** Sends every queued data point now (tests, shutdown). */
export async function flushOtelExports(): Promise<void> {
  await Promise.all([...exporters.values()].map(({ exporter }) => exporter.flush()))
}

/** Flushes and forgets every exporter and counter (worker shutdown, tests). */
export async function closeOtelExports(): Promise<void> {
  const all = [...exporters.values()]
  exporters.clear()
  await Promise.all(all.map(({ exporter }) => exporter.close()))
  errorSeries.clear()
  bookkeeping.clear()
  locationNames.clear()
}

/** Tests: drop the listener registration. */
export function unregisterOtelListener(): void {
  unsubscribe?.()
  unsubscribe = null
}
