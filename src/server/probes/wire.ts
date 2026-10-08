/**
 * Wire format between Marmot and its probe agents (#91), version 1. Shared by the server routes
 * (`/api/probe/v1/*`) and the agent (`src/probe`), so it imports nothing from Payload or the
 * server. Changes that old agents cannot read need a new version path (`/api/probe/v2/…`).
 *
 *   GET  /api/probe/v1/config   → ProbeConfig (ETag; `If-None-Match` answers 304)
 *   POST /api/probe/v1/results  ← ProbeResultsBody → ProbeResultsResponse
 *
 * Both authenticate with `Authorization: Bearer mp_…` (the location token) and identify the agent
 * with `User-Agent: marmot-probe/<version>` plus the `X-Marmot-Probe-Hostname` and
 * `X-Marmot-Probe-Platform` headers.
 */
import { z } from 'zod'

export const PROBE_API_VERSION = 'v1'
export const PROBE_CONFIG_PATH = `/api/probe/${PROBE_API_VERSION}/config`
export const PROBE_RESULTS_PATH = `/api/probe/${PROBE_API_VERSION}/results`

export const PROBE_HOSTNAME_HEADER = 'x-marmot-probe-hostname'
export const PROBE_PLATFORM_HEADER = 'x-marmot-probe-platform'
export const PROBE_USER_AGENT_PREFIX = 'marmot-probe/'

/** Results per `POST /results`; the agent sends larger backlogs in several requests. */
export const MAX_RESULTS_PER_REQUEST = 100

/** Results older than this are refused (`stale`): the beat would rewrite history. */
export const MAX_RESULT_AGE_MS = 10 * 60_000

type Id = string | number

export interface ProbeConfig {
  version: 1
  location: { id: string; name: string; slug: string }
  /** Seconds between config refreshes; the server derives it from `PROBE_OFFLINE_AFTER`. */
  refreshSeconds: number
  /**
   * The monitors assigned to the location: monitor documents (relationships as ids, credentials
   * included) without the server's bookkeeping. `status.lastStatus` decides the first cadence.
   */
  monitors: ProbeMonitor[]
  /** Proxies and Docker hosts the monitors reference, by id. */
  resources: {
    proxies: Record<string, Record<string, unknown>>
    dockerHosts: Record<string, Record<string, unknown>>
  }
}

export type ProbeMonitor = Record<string, unknown> & {
  id: Id
  name: string
  type: string
  interval: number
  retryInterval?: number | null
  status?: { lastStatus?: string | null } | null
}

const id = z.union([z.string().min(1).max(64), z.number().int()])

export const probeResultSchema = z.object({
  monitorId: id,
  /** When the check finished (ISO 8601). */
  time: z.iso.datetime({ offset: true }),
  ok: z.boolean(),
  status: z.enum(['up', 'down', 'pending', 'degraded']).optional(),
  msg: z.string().max(5_000).default(''),
  ping: z.number().finite().min(0).nullish(),
  duration: z.number().finite().min(0).nullish(),
  tlsInfo: z.record(z.string(), z.unknown()).nullish(),
  assertions: z.array(z.record(z.string(), z.unknown())).max(100).nullish(),
  blocked: z.boolean().optional(),
  checkerOffline: z.boolean().optional(),
  /** The check could not judge the target (`CheckDeferredError`): held, never DOWN. */
  deferred: z.boolean().optional(),
})
export type ProbeResult = z.input<typeof probeResultSchema>

export const probeResultsBodySchema = z.object({
  results: z.array(probeResultSchema).min(1).max(MAX_RESULTS_PER_REQUEST),
})
export type ProbeResultsBody = z.input<typeof probeResultsBodySchema>

/** Why a result was not recorded. The agent drops it either way (and refreshes its config). */
export type ProbeRejectReason =
  'unknown-monitor' | 'not-assigned' | 'inactive' | 'unsupported-type' | 'stale' | 'duplicate'

export interface ProbeResultOutcome {
  monitorId: string
  accepted: boolean
  reason?: ProbeRejectReason
  /** Recorded status after the state machine (accepted results). */
  status?: string
  /** Seconds until the next check: `retryInterval` while PENDING, else `interval`. */
  nextCheckSeconds?: number
}

export interface ProbeResultsResponse {
  accepted: number
  results: ProbeResultOutcome[]
}
