/**
 * Push signal ingestion: the one place a `success`, `fail`, `start` or `log` signal of a push
 * monitor is applied, whatever transport it arrived by (the HTTP endpoint today, ping-by-email
 * later). Successes and failures go through the engine (`recordExternalBeat`) like the original
 * push endpoint; `start` only opens a run, `log` only records an event. Every signal is kept in the
 * `push-events` ping log (newest `PUSH_EVENTS_PER_MONITOR` per monitor).
 *
 * Signal semantics follow healthchecks.io: `/start` opens a run that must finish within the grace
 * period, a success or failure closes it (paired by `rid` when given) and its duration becomes the
 * heartbeat's `ping`, so the response-time chart shows job durations.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import {
  closeRun,
  openRun,
  PUSH_EVENTS_PER_MONITOR,
  PUSH_MSG_MAX_LENGTH,
  pushGraceMs,
  storedPushRuns,
  type PushSignalKind,
} from '@/lib/push-schedule'
import type { Heartbeat, Monitor, PushEvent } from '@/payload-types'
import { recordExternalBeat } from '@/server/engine/worker'
import { loadPushScheduleSettings } from '@/server/monitor-types/push'
import { ensureBeatPipeline } from './pipeline'

const log = childLogger('push')

export interface PushSignalInput {
  kind: PushSignalKind
  /** Free text (cut at 250 characters). Defaults: `OK`, `Exit code N` or `Failure reported`. */
  msg?: string | null
  /** Explicit duration in ms; otherwise the duration of the paired run, if any. */
  ping?: number | null
  /** Pairs a start with its success/failure when runs overlap. */
  rid?: string | null
  /** Exit code reported by `/api/push/:token/:code`. */
  exitCode?: number | null
  /** Captured request body (already cut at `PUSH_BODY_LIMIT_BYTES`). */
  body?: string | null
  bodyTruncated?: boolean
  /** Transport the signal arrived by. */
  source?: PushEvent['source']
  /** HTTP method, for the ping log. */
  method?: string | null
}

export interface PushSignalResult {
  /** The heartbeat written for a success or failure; `null` for `start` and `log`. */
  heartbeat: Heartbeat | null
  /** The monitor after the signal. */
  monitor: Monitor
  event: PushEvent
  /** Duration of the run the signal closed, in ms. */
  durationMs: number | null
}

const relationId = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id: string | number }).id ?? null
  return value as string | number
}

const cleanMsg = (msg: string | null | undefined): string | null =>
  msg?.trim().slice(0, PUSH_MSG_MAX_LENGTH) || null

/**
 * Apply one signal to an (active) push monitor at `now`. The caller resolves the monitor and its
 * access (push token, later the email address); this function does not check `active` or `type`.
 */
export async function ingestPushSignal(
  payload: Payload,
  monitor: Monitor,
  input: PushSignalInput,
  options: { now?: Date } = {},
): Promise<PushSignalResult> {
  ensureBeatPipeline(payload)
  const now = options.now ?? new Date()
  const rid = input.rid || null
  const msg = cleanMsg(input.msg)
  const runs = storedPushRuns(monitor)

  let heartbeat: Heartbeat | null = null
  let updated = monitor
  let durationMs: number | null = null
  let eventMsg = msg

  if (input.kind === 'start') {
    updated = (await payload.update({
      collection: 'monitors',
      id: monitor.id,
      depth: 0,
      overrideAccess: true,
      context: { skipEngineSync: true },
      data: { status: { ...monitor.status, pushRuns: openRun(runs, rid, now) } },
    })) as Monitor
  } else if (input.kind === 'success' || input.kind === 'fail') {
    const settings = await loadPushScheduleSettings(payload, monitor)
    const closed = closeRun(runs, rid, now, pushGraceMs(settings))
    durationMs = closed.durationMs
    const ping =
      typeof input.ping === 'number' && Number.isFinite(input.ping) ? input.ping : durationMs

    let status: 'up' | 'down' = input.kind === 'success' ? 'up' : 'down'
    let beatMsg =
      msg ??
      (input.kind === 'success'
        ? 'OK'
        : typeof input.exitCode === 'number'
          ? `Exit code ${input.exitCode}`
          : 'Failure reported')
    const maxSeconds = settings.pushMaxDuration
    if (status === 'up' && durationMs !== null && maxSeconds && durationMs > maxSeconds * 1000) {
      status = 'down'
      beatMsg = `Run took ${Math.round(durationMs / 1000)}s, longer than the maximum duration of ${maxSeconds}s`
    }
    eventMsg = beatMsg

    const result = await recordExternalBeat(
      payload,
      monitor,
      { status, msg: beatMsg, ping },
      { now, statusPatch: { lastPushStatus: status, pushRuns: closed.runs } },
    )
    heartbeat = result.heartbeat
    updated = result.monitor
  }

  const event = (await payload.create({
    collection: 'push-events',
    depth: 0,
    overrideAccess: true,
    data: {
      monitor: monitor.id,
      organization: relationId(monitor.organization) as PushEvent['organization'],
      kind: input.kind,
      source: input.source ?? 'http',
      msg: eventMsg,
      body: input.body || null,
      bodyTruncated: Boolean(input.bodyTruncated),
      rid,
      exitCode: typeof input.exitCode === 'number' ? input.exitCode : null,
      duration: durationMs,
      method: input.method?.slice(0, 10) ?? null,
      time: now.toISOString(),
    },
  })) as PushEvent

  await prunePushEvents(payload, monitor.id).catch((err: unknown) =>
    log.warn({ err, monitorId: monitor.id }, 'failed to prune push events'),
  )
  log.debug({ monitorId: monitor.id, kind: input.kind, rid }, 'push signal received')
  return { heartbeat, monitor: updated, event, durationMs }
}

/** Keep the newest `keep` ping log entries of a monitor. Returns how many were deleted. */
export async function prunePushEvents(
  payload: Payload,
  monitorId: string | number,
  keep: number = PUSH_EVENTS_PER_MONITOR,
): Promise<number> {
  // The first entry past the limit (newest first); everything at or before it goes.
  const { docs } = await payload.find({
    collection: 'push-events',
    where: { monitor: { equals: monitorId } },
    sort: '-time',
    limit: 1,
    page: keep + 1,
    depth: 0,
    overrideAccess: true,
    select: { time: true },
  })
  const boundary = docs[0]
  if (!boundary) return 0
  const result = await payload.delete({
    collection: 'push-events',
    where: {
      and: [{ monitor: { equals: monitorId } }, { time: { less_than_equal: boundary.time } }],
    },
    depth: 0,
    overrideAccess: true,
  })
  return result.docs.length
}
