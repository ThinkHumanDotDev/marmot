/**
 * Host monitor (#136, passive): a host agent (`src/host-agent.ts`) pushes CPU, memory, disk,
 * network, temperature and container figures to `POST /api/agent/v1/metrics` every interval; the
 * samples land in the `host-metrics` rollups. This periodic check judges them:
 *
 * - no sample within `interval + grace` (`pushGrace`, by default 10 % of the interval, as for push
 *   monitors): DOWN, "No metrics received …";
 * - a `down` threshold breached: DOWN with the breach, e.g. "disk / at 93 % (> 90 %)";
 * - a `degraded` threshold breached: DEGRADED;
 * - otherwise UP with a short summary.
 *
 * Thresholds with a duration hold over the minutely rollups (`evaluateHostThresholds`).
 */
import {
  describeBreach,
  describeHealthy,
  evaluateHostThresholds,
  hostGraceMs,
  parseHostThresholds,
} from '@/lib/host-metrics'
import { recentHostRows } from '@/server/host-metrics/ingest'

import { registerMonitorType } from './registry'

const ageText = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds}s`
}

registerMonitorType({
  name: 'host',
  label: 'Host (agent)',
  group: 'passive',
  // PENDING while waiting for the first sample, DEGRADED for degraded thresholds.
  allowCustomStatus: true,
  async check(ctx) {
    const { monitor } = ctx
    ctx.heartbeat.ping = null
    const now = Date.now()
    const thresholds = parseHostThresholds(monitor.hostThresholds)
    const longest = thresholds.reduce((max, t) => Math.max(max, t.duration), 0)
    const lookBackSeconds = longest + monitor.interval + 180
    const sinceKey = Math.floor((now - lookBackSeconds * 1000) / 60_000) * 60
    const rows = await recentHostRows(
      ctx.payload,
      monitor.id,
      sinceKey,
      Math.ceil(lookBackSeconds / 60) + 2,
    )
    const deadline = monitor.interval * 1000 + hostGraceMs(monitor)
    const newest = rows[0]
    if (!newest) {
      const created = monitor.createdAt ? new Date(monitor.createdAt).getTime() : now
      if (now - created <= deadline) {
        ctx.heartbeat.status = 'pending'
        ctx.heartbeat.msg = 'Waiting for the first metrics from the host agent'
        return
      }
      throw new Error('No metrics received from the host agent')
    }
    const age = now - newest.lastAt
    if (age > deadline) {
      ctx.heartbeat.duration = Math.round(age / 1000)
      throw new Error(`No metrics received for ${ageText(age)}`)
    }

    const verdict = evaluateHostThresholds(thresholds, rows, new Date(now), monitor.interval)
    const latest = Object.fromEntries(
      Object.entries(newest.series).map(([key, aggregate]) => [key, aggregate[4]]),
    )
    if (verdict.status === 'up') {
      ctx.heartbeat.status = 'up'
      ctx.heartbeat.msg = describeHealthy(latest)
      return
    }
    // Every breach, the DOWN ones first.
    const message = [...verdict.breaches]
      .sort(
        (a, b) => Number(b.threshold.severity === 'down') - Number(a.threshold.severity === 'down'),
      )
      .map(describeBreach)
      .join('; ')
    if (verdict.status === 'down') throw new Error(message)
    ctx.heartbeat.status = 'degraded'
    ctx.heartbeat.msg = message
  },
})
