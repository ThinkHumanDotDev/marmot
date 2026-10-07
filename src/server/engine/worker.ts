import type { Job } from 'bullmq'
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Heartbeat, Monitor } from '@/payload-types'
import { getMonitorType, type MonitorCheckContext } from '@/server/monitor-types'
import { computeNextBeat, type CheckResult, type NextState, type PrevState } from './beat'
import { emitHeartbeat, isUnderMaintenance } from './hooks'
import type { CheckJobData, QueueFactoryOptions } from './queues'
import { effectiveIntervalMs, removeMonitorSchedule, syncMonitor } from './scheduler'
import { certificateChanged } from './tls'
import { findBlockedMessage } from '@/server/security/outbound-guard'

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

/** Effective timeout: Uptime Kuma falls back to 80% of the interval when timeout is 0. */
export function checkTimeoutMs(monitor: Pick<Monitor, 'timeout' | 'interval'>): number {
  const seconds =
    monitor.timeout && monitor.timeout > 0 ? monitor.timeout : Math.max(1, monitor.interval) * 0.8
  return Math.round(seconds * 1000)
}

const HEARTBEAT_CORE_FIELDS = new Set(['status', 'msg', 'ping', 'duration'])

/** Type-specific fields a check put on `ctx.heartbeat` (e.g. `statusCode`). */
function heartbeatDetails(heartbeat: MonitorCheckContext['heartbeat']): Record<string, unknown> {
  const details: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(heartbeat)) {
    if (!HEARTBEAT_CORE_FIELDS.has(key) && value !== undefined) details[key] = value
  }
  return details
}

const isTimeoutError = (err: unknown) =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')

/**
 * Run the monitor type's `check()` bounded by the timeout signal. Types that ignore the signal are
 * still cut off by the race; the dangling promise is swallowed.
 */
export async function runCheck(
  payload: Payload,
  monitor: Monitor,
  timeoutMs: number,
): Promise<CheckResult> {
  const type = getMonitorType(monitor.type)
  if (!type) {
    return { ok: false, msg: `Unknown monitor type "${monitor.type}"` }
  }

  const signal = AbortSignal.timeout(timeoutMs)
  const ctx: MonitorCheckContext = {
    monitor,
    heartbeat: { status: 'down', msg: '' },
    signal,
    payload,
  }
  const startedAt = Date.now()

  const timeout = new Promise<never>((_, reject) => {
    const onAbort = () => {
      const err = new Error(`timeout by AbortSignal (${Math.round(timeoutMs / 1000)}s)`)
      err.name = 'TimeoutError'
      reject(err)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    await Promise.race([type.check(ctx), timeout])
  } catch (err) {
    // A target refused by the outbound address guard reads the same for every type and driver.
    const blocked = findBlockedMessage(err)
    const msg = blocked
      ? blocked
      : isTimeoutError(err)
        ? `timeout by AbortSignal (${Math.round(timeoutMs / 1000)}s)`
        : err instanceof Error
          ? err.message
          : String(err)
    return {
      ok: false,
      msg,
      ...(blocked ? { blocked: true } : {}),
      ping: ctx.heartbeat.ping ?? null,
      duration: typeof ctx.heartbeat.duration === 'number' ? ctx.heartbeat.duration : null,
      tlsInfo: ctx.tlsInfo ?? null,
      details: heartbeatDetails(ctx.heartbeat),
    }
  }

  if (!type.allowCustomStatus && ctx.heartbeat.status !== 'up') {
    return {
      ok: false,
      msg: 'The monitor implementation is incorrect, non-UP error must throw error inside check()',
      tlsInfo: ctx.tlsInfo ?? null,
    }
  }

  return {
    ok: true,
    status: ctx.heartbeat.status,
    msg: ctx.heartbeat.msg,
    ping: ctx.heartbeat.ping ?? Date.now() - startedAt,
    duration: typeof ctx.heartbeat.duration === 'number' ? ctx.heartbeat.duration : null,
    tlsInfo: ctx.tlsInfo ?? null,
    details: heartbeatDetails(ctx.heartbeat),
  }
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

  const timeoutMs = checkTimeoutMs(monitor)
  const underMaintenance = await isUnderMaintenance(monitor, payload)
  const result: CheckResult = underMaintenance
    ? { ok: false, msg: 'Monitor under maintenance', underMaintenance: true }
    : await runCheck(payload, monitor, timeoutMs)

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
}

export interface RecordBeatResult {
  heartbeat: Heartbeat
  /** Monitor document after the status cache update. */
  monitor: Monitor
  next: NextState
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
  }
  const next = computeNextBeat(prev, result, monitor)

  const now = options.now ?? new Date()
  const lastCheckAt = monitor.status?.lastCheckAt ? new Date(monitor.status.lastCheckAt) : null
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
        ...options.statusPatch,
      },
      ...(tlsInfo ? { certInfo: tlsInfo as unknown as Monitor['certInfo'] } : {}),
    },
  })) as Monitor

  // PENDING monitors poll at `retryInterval`; back to `interval` once they leave PENDING.
  if (effectiveIntervalMs(updated) !== effectiveIntervalMs(monitor)) {
    try {
      await syncMonitor(updated, options.queue)
    } catch (err) {
      log.error({ err, monitorId }, 'failed to re-plan scheduler')
    }
  }

  const level = next.status === 'up' ? 'debug' : 'warn'
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
    organizationId,
    tlsInfo,
    certChanged,
  })

  return { heartbeat, monitor: updated, next }
}

export interface ExternalBeatInput {
  status: 'up' | 'down'
  msg?: string | null
  ping?: number | null
}

/**
 * Record a beat reported from outside the worker (the push endpoint). Maintenance windows,
 * retries/PENDING and `upsideDown` apply exactly as for polled checks; the monitor's
 * `status.lastPushAt` is stamped so the periodic push check knows the heartbeat arrived.
 * Port of the `/api/push/:pushToken` handler in Uptime Kuma 2.5.5 `server/routers/api-router.js`.
 */
export async function recordExternalBeat(
  payload: Payload,
  monitor: Monitor,
  input: ExternalBeatInput,
  options: Omit<RecordBeatOptions, 'statusPatch'> = {},
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
    statusPatch: { lastPushAt: now.toISOString() },
  })
}
