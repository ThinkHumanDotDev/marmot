/**
 * Worker side of the on-demand checks (see `on-demand.ts`): the processors of the `manual-check`
 * and `adhoc-check` jobs and the shaping of their result.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import {
  supportsAdhocTest,
  supportsCheckNow,
  type OnDemandCheckResult,
  type OnDemandCheckStatus,
} from '@/lib/on-demand-check'
import type { Heartbeat, Monitor } from '@/payload-types'
import { computeNextBeat, type CheckResult } from './beat'
import { guardAgainstOfflineChecker } from './connectivity'
import { isUnderMaintenance } from './hooks'
import { OnDemandSkipError } from './on-demand'
import type { AdhocCheckJobData, ManualCheckJobData } from './queues'
import type { syncMonitor } from './scheduler'
import { checkTimeoutMs, recordBeat, runCheck } from './worker'

const log = childLogger('engine:on-demand')

const tlsSummary = (tlsInfo: CheckResult['tlsInfo']): OnDemandCheckResult['tls'] => {
  if (!tlsInfo) return null
  const cert = tlsInfo.certInfo
  return {
    valid: tlsInfo.valid,
    daysRemaining: cert?.daysRemaining ?? null,
    validTo: cert?.validTo ?? null,
    issuer: cert?.issuerCN ?? null,
    subject: cert?.subjectCN ?? null,
  }
}

/** Shape a check result for the API (JSON-safe: it travels through Redis). */
export function toOnDemandResult(
  result: CheckResult,
  status: OnDemandCheckStatus,
  startedAt: Date,
  options: { msg?: string; heartbeat?: Heartbeat | null } = {},
): OnDemandCheckResult {
  const { statusCode, ...details } = result.details ?? {}
  const heartbeat = options.heartbeat ?? null
  return {
    status,
    ok: result.ok,
    msg: options.msg ?? result.msg,
    ping: typeof result.ping === 'number' ? result.ping : null,
    startedAt: startedAt.toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
    blocked: Boolean(result.blocked),
    maintenance: Boolean(result.underMaintenance),
    statusCode: typeof statusCode === 'number' ? statusCode : null,
    tls: tlsSummary(result.tlsInfo),
    assertions: result.assertions?.length
      ? (JSON.parse(JSON.stringify(result.assertions)) as OnDemandCheckResult['assertions'])
      : null,
    timing: result.timing ? { ...result.timing } : null,
    details: JSON.parse(JSON.stringify(details)) as Record<string, unknown>,
    recorded: heartbeat !== null,
    heartbeat: heartbeat
      ? {
          id: String(heartbeat.id),
          status: heartbeat.status,
          time: heartbeat.time,
          important: Boolean(heartbeat.important),
        }
      : null,
  }
}

/**
 * Status a check would have without touching the monitor's state: `upsideDown` applies, retries do
 * not (a failing dry run reads DOWN, not PENDING).
 */
function dryRunStatus(result: CheckResult, monitor: Monitor) {
  return computeNextBeat(null, result, { ...monitor, maxRetries: 0, resendInterval: 0 })
}

function assertNotExpired(deadline: number) {
  if (Number.isFinite(deadline) && Date.now() > deadline) throw new OnDemandSkipError('expired')
}

/** Worker side of `manual-check`. */
export async function processManualCheckJob(
  payload: Payload,
  data: ManualCheckJobData,
  options: { queue?: Parameters<typeof syncMonitor>[1] } = {},
): Promise<OnDemandCheckResult> {
  assertNotExpired(data.deadline)
  const monitor = (await payload
    .findByID({ collection: 'monitors', id: data.monitorId, depth: 0, overrideAccess: true })
    .catch(() => null)) as Monitor | null
  if (!monitor) throw new OnDemandSkipError('not-found')
  if (!monitor.active) throw new OnDemandSkipError('inactive')
  if (!supportsCheckNow(monitor.type)) throw new OnDemandSkipError('not-applicable')

  const startedAt = new Date()
  const result: CheckResult = (await isUnderMaintenance(monitor, payload))
    ? { ok: false, msg: 'Monitor under maintenance', underMaintenance: true }
    : data.record
      ? // A recorded check feeds the state machine: hold it while the worker is offline (#148).
        await guardAgainstOfflineChecker(payload, monitor, () =>
          runCheck(payload, monitor, checkTimeoutMs(monitor)),
        )
      : await runCheck(payload, monitor, checkTimeoutMs(monitor))

  if (!data.record) {
    const next = dryRunStatus(result, monitor)
    return toOnDemandResult(result, next.status, startedAt, { msg: next.msg })
  }
  const { heartbeat, next } = await recordBeat(payload, monitor, result, {
    queue: options.queue,
    trigger: 'manual',
  })
  log.info({ monitorId: data.monitorId, status: next.status }, 'manual check recorded')
  return toOnDemandResult(result, next.status, startedAt, { msg: next.msg, heartbeat })
}

/** Worker side of `adhoc-check`: run an unsaved configuration, store nothing. */
export async function processAdhocCheckJob(
  payload: Payload,
  data: AdhocCheckJobData,
): Promise<OnDemandCheckResult> {
  assertNotExpired(data.deadline)
  if (!supportsAdhocTest(data.monitor.type)) throw new OnDemandSkipError('not-applicable')
  const monitor = {
    ...data.monitor,
    id: 'adhoc',
    organization: data.organizationId,
    active: true,
    status: null,
    certInfo: null,
  } as unknown as Monitor
  const startedAt = new Date()
  const result = await runCheck(payload, monitor, checkTimeoutMs(monitor))
  const next = dryRunStatus(result, monitor)
  return toOnDemandResult(result, next.status, startedAt, { msg: next.msg })
}
