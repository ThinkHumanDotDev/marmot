/**
 * Push monitor (passive): the monitored system calls `/api/push/<pushToken>[/start|/fail|/log|/<code>]`;
 * the endpoint records successes and failures as heartbeats and keeps the run bookkeeping in
 * `monitors.status` (`lastPushAt`, `lastPushStatus`, `pushRuns`). This periodic check only decides
 * whether the next ping is overdue (`evaluatePush` in `src/lib/push-schedule.ts`): after
 * `interval + grace`, or after the next occurrence of the cron expression plus grace.
 *
 * Inspired by the `push` branch of Uptime Kuma 2.5.5 `server/model/monitor.js` (MIT, Louis Lam);
 * cron schedules, grace periods and start/fail signals follow healthchecks.io.
 */
import type { Monitor } from '@/payload-types'
import {
  evaluatePush,
  legacyGraceMs,
  pushStateOf,
  type PushScheduleSettings,
} from '@/lib/push-schedule'
import { SAME_AS_SERVER } from '@/lib/validation/maintenance'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'
import { registerMonitorType } from './registry'

/** Allowance for clock drift and scheduler jitter: 10% of the interval, at least 1s. */
export function pushGraceMs(intervalSeconds: number): number {
  return legacyGraceMs(intervalSeconds)
}

const relationId = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id: string | number }).id ?? null
  return value as string | number
}

/** Schedule settings of a monitor with the cron zone resolved (its own, or the organization's). */
export async function pushScheduleSettings(
  monitor: Monitor,
  orgTimezone: () => Promise<string>,
): Promise<PushScheduleSettings> {
  const cron = monitor.pushSchedule === 'cron'
  const own = monitor.pushTimezone?.trim()
  const timezone = !cron ? 'UTC' : own && own !== SAME_AS_SERVER ? own : await orgTimezone()
  return {
    interval: monitor.interval,
    pushSchedule: monitor.pushSchedule ?? 'interval',
    pushCron: monitor.pushCron ?? null,
    timezone,
    pushGrace: monitor.pushGrace ?? null,
    pushMaxDuration: monitor.pushMaxDuration ?? null,
  }
}

/** Resolve the schedule of a monitor with the organization's zone from the database. */
export function loadPushScheduleSettings(
  payload: Parameters<typeof getOrganizationTimezone>[0],
  monitor: Monitor,
): Promise<PushScheduleSettings> {
  return pushScheduleSettings(monitor, () =>
    getOrganizationTimezone(payload, relationId(monitor.organization)),
  )
}

registerMonitorType({
  name: 'push',
  label: 'Push',
  group: 'passive',
  // PENDING while a cron schedule waits for its first ping.
  allowCustomStatus: true,
  async check(ctx) {
    const { monitor } = ctx
    const settings = await loadPushScheduleSettings(ctx.payload, monitor)
    const verdict = evaluatePush(settings, pushStateOf(monitor), new Date())
    ctx.heartbeat.ping = null

    switch (verdict.reason) {
      case 'ok':
        ctx.heartbeat.status = 'up'
        ctx.heartbeat.msg = `Last push ${verdict.ageSeconds}s ago`
        return
      case 'running':
        ctx.heartbeat.status = 'up'
        ctx.heartbeat.msg = `Running for ${verdict.ageSeconds}s`
        return
      case 'waiting':
        ctx.heartbeat.status = 'pending'
        ctx.heartbeat.msg = verdict.nextExpectedAt
          ? `Waiting for the first ping (expected at ${verdict.nextExpectedAt.toISOString()})`
          : 'Waiting for the first ping'
        return
      case 'no-ping':
        ctx.heartbeat.duration = monitor.interval
        throw new Error('No heartbeat in the time window')
      case 'late':
        ctx.heartbeat.duration = verdict.ageSeconds ?? monitor.interval
        throw new Error('No heartbeat in the time window')
      case 'failed':
        throw new Error(monitor.status?.lastMsg || 'The last run reported a failure')
      case 'run-timeout':
        ctx.heartbeat.duration = verdict.ageSeconds
        throw new Error(
          `Run started ${verdict.ageSeconds}s ago did not finish within the grace period`,
        )
      case 'run-too-long':
        ctx.heartbeat.duration = verdict.ageSeconds
        throw new Error(
          `Run started ${verdict.ageSeconds}s ago exceeds the maximum duration of ${
            settings.pushMaxDuration ?? 0
          }s`,
        )
      case 'invalid-schedule':
        throw new Error('Invalid cron expression')
    }
  },
})
