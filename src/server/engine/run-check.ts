/**
 * Running one check of a monitor: the monitor type's `check()` bounded by the timeout, its outcome
 * turned into a `CheckResult` for the state machine. Kept apart from the BullMQ processor
 * (`worker.ts`) so the probe agent (`src/probe`) can run checks without Redis or the database.
 */
import {
  getMonitorType,
  isCheckDeferredError,
  type MonitorCheckContext,
} from '@/server/monitor-types'
import type { Monitor } from '@/payload-types'
import { findBlockedMessage } from '@/server/security/outbound-guard'
import type { Payload } from 'payload'

import type { CheckResult } from './beat'

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
    // The check could not judge the target (rate limit): the beat is held, never DOWN (#142).
    if (isCheckDeferredError(err)) {
      return {
        ok: false,
        msg: err.message,
        deferred: true,
        details: heartbeatDetails(ctx.heartbeat),
        probes: ctx.probes ?? null,
      }
    }
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
      assertions: ctx.assertions ?? null,
      timing: ctx.timing ?? null,
      probes: ctx.probes ?? null,
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
    assertions: ctx.assertions ?? null,
    timing: ctx.timing ?? null,
    probes: ctx.probes ?? null,
  }
}
