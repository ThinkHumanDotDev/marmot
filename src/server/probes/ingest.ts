/**
 * `POST /api/probe/v1/results` (#91): results a probe agent ran in its own network go through the
 * same state machine as the workers' checks (`recordBeat`: retries, upside-down, recovery threshold,
 * notifications, stats, realtime), with the location recorded on the heartbeat. Maintenance windows
 * are applied here, on the server, like for push monitors (`recordExternalBeat`).
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { monitorLocationIds, probeSupportsType } from '@/lib/probe-locations'
import type { Location, Monitor } from '@/payload-types'
import type { AssertionResult } from '@/lib/validation/assertions'
import { nextIntervalSeconds, type CheckResult } from '@/server/engine/beat'
import type { TlsInfo } from '@/server/engine/tls'
import { recordBeat } from '@/server/engine/worker'
import { isMonitorUnderMaintenance } from '@/server/maintenance/resolver'
import { ensureBeatPipeline } from '@/server/push/pipeline'

import {
  MAX_RESULT_AGE_MS,
  type ProbeRejectReason,
  type ProbeResultOutcome,
  type ProbeResultsResponse,
  probeResultSchema,
} from './wire'
import type { z } from 'zod'

const log = childLogger('probes:ingest')

type ParsedResult = z.output<typeof probeResultSchema>

/** The wire result as the state machine's `CheckResult`. */
export function toCheckResult(result: ParsedResult): CheckResult {
  return {
    ok: result.ok,
    ...(result.ok ? { status: result.status ?? 'up' } : {}),
    msg: result.msg,
    ping: result.ping ?? null,
    duration: result.duration ?? null,
    tlsInfo: (result.tlsInfo as TlsInfo | null | undefined) ?? null,
    assertions: (result.assertions as AssertionResult[] | null | undefined) ?? null,
    ...(result.blocked ? { blocked: true } : {}),
    ...(result.checkerOffline ? { checkerOffline: true } : {}),
    ...(result.deferred ? { deferred: true } : {}),
  }
}

export interface IngestOptions {
  now?: Date
  /** Listeners (stats, realtime, incidents, notifications); off in tests that only need rows. */
  pipeline?: boolean
}

/**
 * Record a batch of results from `location`'s agent, in order. Each result is checked against the
 * monitor (same organization, assigned to this location, active, a type probes run) and refused
 * when it is older than `MAX_RESULT_AGE_MS` or not newer than the monitor's last check (a batch the
 * agent re-sends after a lost response is therefore recorded once).
 */
export async function ingestProbeResults(
  payload: Payload,
  location: Location,
  results: ParsedResult[],
  options: IngestOptions = {},
): Promise<ProbeResultsResponse> {
  if (options.pipeline !== false) ensureBeatPipeline(payload)
  const now = options.now ?? new Date()
  const organizationId = String(
    typeof location.organization === 'object' ? location.organization.id : location.organization,
  )
  const monitors = new Map<string, Monitor | null>()
  const outcomes: ProbeResultOutcome[] = []

  const load = async (id: string | number): Promise<Monitor | null> => {
    const key = String(id)
    if (!monitors.has(key)) {
      const doc = (await payload
        .findByID({ collection: 'monitors', id, depth: 0, overrideAccess: true })
        .catch(() => null)) as Monitor | null
      monitors.set(key, doc)
    }
    return monitors.get(key) ?? null
  }

  for (const result of results) {
    const monitorId = String(result.monitorId)
    const reject = (reason: ProbeRejectReason) =>
      outcomes.push({ monitorId, accepted: false, reason })

    const monitor = await load(result.monitorId)
    const owner =
      monitor && typeof monitor.organization === 'object'
        ? monitor.organization.id
        : monitor?.organization
    if (!monitor || String(owner) !== organizationId) {
      reject('unknown-monitor')
      continue
    }
    if (!monitorLocationIds(monitor).some((id) => String(id) === String(location.id))) {
      reject('not-assigned')
      continue
    }
    if (!monitor.active) {
      reject('inactive')
      continue
    }
    if (!probeSupportsType(monitor.type)) {
      reject('unsupported-type')
      continue
    }

    const time = new Date(Math.min(Date.parse(result.time), now.getTime()))
    if (now.getTime() - time.getTime() > MAX_RESULT_AGE_MS) {
      reject('stale')
      continue
    }
    const lastCheckAt = monitor.status?.lastCheckAt ? Date.parse(monitor.status.lastCheckAt) : 0
    if (time.getTime() <= lastCheckAt) {
      reject('duplicate')
      continue
    }

    try {
      const underMaintenance = await isMonitorUnderMaintenance(payload, monitor.id, { monitor })
      const check: CheckResult = underMaintenance
        ? { ok: false, msg: 'Monitor under maintenance', underMaintenance: true }
        : toCheckResult(result)
      const recorded = await recordBeat(payload, monitor, check, {
        now: time,
        location: location.id,
      })
      monitors.set(monitorId, recorded.monitor)
      outcomes.push({
        monitorId,
        accepted: true,
        status: recorded.next.status,
        nextCheckSeconds: nextIntervalSeconds(recorded.next.status, recorded.monitor),
      })
    } catch (err) {
      log.error({ err, monitorId, locationId: location.id }, 'failed to record a probe result')
      throw err
    }
  }

  return { accepted: outcomes.filter((o) => o.accepted).length, results: outcomes }
}
