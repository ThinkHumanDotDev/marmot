import type { Job } from 'bullmq'
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Heartbeat, Monitor } from '@/payload-types'
import {
  computeNextBeat,
  nextIntervalSeconds,
  type CheckResult,
  type NextState,
  type PrevState,
} from './beat'
import { emitHeartbeat, isUnderMaintenance } from './hooks'
import type { CheckJobData, QueueFactoryOptions } from './queues'
import { effectiveIntervalMs, removeMonitorSchedule, syncMonitor } from './scheduler'
import { DEFAULT_LOCATION, guardAgainstOfflineChecker } from './connectivity'
import { certificateChanged } from './tls'
import {
  heartbeatLocationKey,
  isMultiLocation,
  isRemoteMonitor,
  LOCAL_LOCATION,
} from '@/lib/probe-locations'
import { applyQuorum, type QuorumOutcome } from './quorum-store'
import { checkTimeoutMs, runCheck } from './run-check'

export { checkTimeoutMs, runCheck } from './run-check'

const log = childLogger('engine:worker')

/** Minimal job shape the processor needs, so tests can pass a plain object. */
export type CheckJobLike = Pick<Job<CheckJobData>, 'data'> & Partial<Pick<Job, 'id' | 'name'>>

export interface ProcessCheckResult {
  /** `skipped` when the monitor is missing, paused or of an unknown type. */
  outcome: 'processed' | 'skipped'
  reason?: string
  heartbeat?: Heartbeat
  next?: NextState
}

const relationId = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id: string | number }).id ?? null
  return value as string | number
}

/**
 * Job processor: load → check → state machine → persist heartbeat → refresh status cache →
 * re-plan scheduler if the cadence changed → notify listeners. Exported so tests can call it
 * with a fake job and no live BullMQ worker.
 */
export async function processCheckJob(
  payload: Payload,
  job: CheckJobLike,
  queueOptions?: QueueFactoryOptions & { queue?: Parameters<typeof syncMonitor>[1] },
): Promise<ProcessCheckResult> {
  const monitorId = job.data.monitorId
  const monitor = (await payload
    .findByID({ collection: 'monitors', id: monitorId, depth: 0, overrideAccess: true })
    .catch(() => null)) as Monitor | null

  if (!monitor) {
    log.warn({ monitorId }, 'monitor not found; removing scheduler')
    await removeMonitorSchedule(monitorId, queueOptions?.queue).catch(() => undefined)
    return { outcome: 'skipped', reason: 'not-found' }
  }
  if (!monitor.active) {
    await removeMonitorSchedule(monitorId, queueOptions?.queue).catch(() => undefined)
    return { outcome: 'skipped', reason: 'inactive' }
  }
  // Checked by a probe location (#91): a scheduler left over from before the assignment goes.
  if (isRemoteMonitor(monitor)) {
    await removeMonitorSchedule(monitorId, queueOptions?.queue).catch(() => undefined)
    return { outcome: 'skipped', reason: 'remote' }
  }

  const timeoutMs = checkTimeoutMs(monitor)
  const underMaintenance = await isUnderMaintenance(monitor, payload)
  const result: CheckResult = underMaintenance
    ? { ok: false, msg: 'Monitor under maintenance', underMaintenance: true }
    : await guardAgainstOfflineChecker(
        payload,
        monitor,
        () => runCheck(payload, monitor, timeoutMs),
        DEFAULT_LOCATION,
      )

  const { heartbeat, next } = await recordBeat(payload, monitor, result, {
    queue: queueOptions?.queue,
  })
  return { outcome: 'processed', heartbeat, next }
}

export interface RecordBeatOptions {
  /** Queue to re-plan the scheduler on; the shared checks queue by default. */
  queue?: Parameters<typeof syncMonitor>[1]
  /** Extra `status` fields to persist alongside the beat (e.g. `lastPushAt`). */
  statusPatch?: Partial<NonNullable<Monitor['status']>>
  /** Beat time; defaults to now. */
  now?: Date
  /** What started the check; stored on the heartbeat. Scheduled checks leave it unset. */
  trigger?: Heartbeat['trigger']
  /** Probe location that ran the check (#91); unset for the local worker pool and pushes. */
  location?: string | number | null
}

export interface RecordBeatResult {
  heartbeat: Heartbeat
  /** Monitor document after the status cache update. */
  monitor: Monitor
  /** The monitor-level beat (the quorum on a multi-location monitor). */
  next: NextState
  /**
   * Multi-location monitors (#92): the reporting location's own beat, whose cadence
   * (`nextIntervalSeconds`) the location follows. Unset on single-location monitors.
   */
  locationNext?: NextState
}

/**
 * Feed a check result through the state machine and persist it: `heartbeats` row, `monitors.status`
 * cache (with `context.skipEngineSync`), scheduler re-plan when the cadence changed, listeners.
 * Shared by the check worker and the push endpoint (`recordExternalBeat`).
 */
export async function recordBeat(
  payload: Payload,
  monitor: Monitor,
  result: CheckResult,
  options: RecordBeatOptions = {},
): Promise<RecordBeatResult> {
  const monitorId = String(monitor.id)
  const prev: PrevState = {
    status: monitor.status?.lastStatus,
    retries: monitor.status?.retries,
    downCount: monitor.status?.downCount,
    settledStatus: monitor.status?.settledStatus,
    recoveries: monitor.status?.recoveries,
  }
  const now = options.now ?? new Date()
  // Several locations (#92): the location's beat runs on its own state and the monitor's status
  // is their quorum. A single location keeps the plain state machine on `monitor.status`.
  const locationKey = heartbeatLocationKey(options.location)
  const quorum: QuorumOutcome | null = isMultiLocation(monitor)
    ? await applyQuorum(payload, monitor, locationKey, result, now)
    : null
  const next = quorum ? quorum.next : computeNextBeat(prev, result, monitor)
  // A beat held while the worker was offline (#148) or deferred by the check (#142) leaves the
  // cached status as it was.
  const held = result.checkerOffline === true || result.deferred === true

  // Seconds since the previous check of the same vantage point.
  const previousCheckAt = quorum ? quorum.location.lastCheckAt : monitor.status?.lastCheckAt
  const lastCheckAt = previousCheckAt ? new Date(previousCheckAt) : null
  const duration =
    next.duration ??
    (lastCheckAt ? Math.round((now.getTime() - lastCheckAt.getTime()) / 1000) : null)
  const organizationId = relationId(monitor.organization)
  // Certificate seen by this check (HTTPS types). Stored on the monitor so the detail page and the
  // expiry notifications never have to re-connect; `certChanged` resets the "already notified" history.
  const tlsInfo = result.tlsInfo ?? null
  const certChanged = certificateChanged(monitor.certInfo, tlsInfo)

  const heartbeat = (await payload.create({
    collection: 'heartbeats',
    depth: 0,
    overrideAccess: true,
    data: {
      monitor: monitor.id,
      organization: organizationId as Heartbeat['organization'],
      status: next.status,
      msg: next.msg,
      ping: next.ping,
      duration,
      important: next.important,
      retries: next.retries,
      downCount: next.downCount,
      time: now.toISOString(),
      ...(options.trigger ? { trigger: options.trigger } : {}),
      ...(options.location !== undefined && options.location !== null
        ? { location: options.location as Heartbeat['location'] }
        : {}),
      ...(quorum ? { locationStatus: quorum.location.next.status } : {}),
      // Per-assertion results for the monitor page (and run-on-demand results); omitted when the
      // type has none, so plain beats stay small.
      ...(result.assertions?.length
        ? { assertions: result.assertions as unknown as Heartbeat['assertions'] }
        : {}),
      // Request timing phases (#94); omitted for types that do not measure them and for held
      // (deferred / checker offline) beats, which measured nothing.
      ...(result.timing && !held ? { timing: result.timing } : {}),
      // Per-probe results of multi-location checks (Globalping, #142).
      ...(result.probes?.length ? { probes: result.probes as unknown as Heartbeat['probes'] } : {}),
    },
  })) as Heartbeat

  const updated = (await payload.update({
    collection: 'monitors',
    id: monitor.id,
    depth: 0,
    overrideAccess: true,
    context: { skipEngineSync: true },
    data: {
      status: {
        ...monitor.status,
        lastStatus: next.status,
        lastCheckAt: now.toISOString(),
        lastPing: next.ping,
        lastMsg: next.msg,
        retries: next.retries,
        downCount: next.downCount,
        settledStatus: next.settledStatus,
        ...(held
          ? { lastStatus: monitor.status?.lastStatus, lastPing: monitor.status?.lastPing }
          : {}),
        recoveries: next.recoveries,
        ...options.statusPatch,
      },
      ...(tlsInfo ? { certInfo: tlsInfo as unknown as Monitor['certInfo'] } : {}),
    },
  })) as Monitor

  // PENDING monitors poll at `retryInterval`; back to `interval` once they leave PENDING. Probe
  // agents read the new cadence from the ingest response instead (`src/server/probes/ingest.ts`).
  // On a multi-location monitor the local workers follow the local location's own state.
  const replan = quorum
    ? locationKey === LOCAL_LOCATION &&
      quorum.location.next.nextIntervalSeconds !==
        nextIntervalSeconds(quorum.location.prev.status ?? 'up', monitor)
    : !isRemoteMonitor(updated) && effectiveIntervalMs(updated) !== effectiveIntervalMs(monitor)
  if (replan) {
    try {
      await syncMonitor(
        quorum ? { ...updated, localStatus: quorum.location.next.status } : updated,
        options.queue,
      )
    } catch (err) {
      log.error({ err, monitorId }, 'failed to re-plan scheduler')
    }
  }

  const level = next.status === 'up' ? 'debug' : next.status === 'degraded' ? 'info' : 'warn'
  log[level](
    {
      monitorId,
      name: monitor.name,
      type: monitor.type,
      status: next.status,
      msg: next.msg,
      ping: next.ping,
      retries: next.retries,
      important: next.important,
      ...(quorum ? { location: locationKey, locationStatus: quorum.location.next.status } : {}),
    },
    'heartbeat',
  )

  await emitHeartbeat({
    payload,
    monitor: updated,
    heartbeat,
    previousStatus: prev.status,
    isFirstBeat: next.isFirstBeat,
    notify: next.notify,
    notificationEvent: next.notificationEvent,
    organizationId,
    tlsInfo,
    certChanged,
    checkerOffline: result.checkerOffline === true,
    deferred: result.deferred === true,
    location: quorum ? { key: locationKey, status: quorum.location.next.status } : null,
  })

  return {
    heartbeat,
    monitor: updated,
    next,
    ...(quorum ? { locationNext: quorum.location.next } : {}),
  }
}

export interface ExternalBeatInput {
  status: 'up' | 'down'
  msg?: string | null
  ping?: number | null
}

/**
 * Record a beat reported from outside the worker (the push endpoint). Maintenance windows,
 * retries/PENDING and `upsideDown` apply exactly as for polled checks; the monitor's
 * `status.lastPushAt` is stamped so the periodic push check knows the heartbeat arrived (plus any
 * `statusPatch`, e.g. the push run bookkeeping).
 * Port of the `/api/push/:pushToken` handler in Uptime Kuma 2.5.5 `server/routers/api-router.js`.
 */
export async function recordExternalBeat(
  payload: Payload,
  monitor: Monitor,
  input: ExternalBeatInput,
  options: RecordBeatOptions = {},
): Promise<RecordBeatResult> {
  const now = options.now ?? new Date()
  const msg = input.msg?.trim() || 'OK'
  const ping = typeof input.ping === 'number' && Number.isFinite(input.ping) ? input.ping : null
  const underMaintenance = await isUnderMaintenance(monitor, payload)
  const result: CheckResult = underMaintenance
    ? { ok: false, msg: 'Monitor under maintenance', underMaintenance: true, ping }
    : input.status === 'up'
      ? { ok: true, status: 'up', msg, ping }
      : { ok: false, msg, ping }
  return recordBeat(payload, monitor, result, {
    ...options,
    now,
    statusPatch: { lastPushAt: now.toISOString(), ...options.statusPatch },
  })
}
