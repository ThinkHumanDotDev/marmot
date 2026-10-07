/**
 * Request timing phases of one check (#94): how long DNS, the TCP connect, the TLS handshake, the
 * server (time to first byte) and the body transfer took, in milliseconds.
 *
 * Shared by the worker (which measures them, `src/server/monitor-types/http-timing.ts`), the stats
 * rollups (per-phase averages in `extras.timing`) and the UI (waterfall, phase chart), so it must
 * stay free of Node-only imports. A phase that does not apply (no TLS on plain HTTP, a reused
 * connection, DNS for an IP literal) is `null`.
 */

export const TIMING_PHASES = ['dns', 'connect', 'tls', 'ttfb', 'transfer'] as const

export type TimingPhase = (typeof TIMING_PHASES)[number]

export type RequestTiming = Record<TimingPhase, number | null>

/** Per-phase running average stored in a stat bucket's `extras.timing`. */
export type TimingAverage = { avg: number; count: number }

export type BucketTiming = Partial<Record<TimingPhase, TimingAverage>>

const isPhaseValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Round to 0.1 ms: sub-millisecond phases are common on local networks. */
export const roundPhase = (ms: number): number => Math.round(Math.max(0, ms) * 10) / 10

/**
 * Read a timing object (a heartbeat's `timing` group, an on-demand result, a JSON payload).
 * Returns `null` when no phase carries a value, so callers can hide the waterfall.
 */
export function parseRequestTiming(value: unknown): RequestTiming | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const timing = {} as RequestTiming
  let any = false
  for (const phase of TIMING_PHASES) {
    const v = source[phase]
    timing[phase] = isPhaseValue(v) ? v : null
    if (timing[phase] !== null) any = true
  }
  return any ? timing : null
}

/** Sum of the measured phases (ms). */
export const timingTotal = (timing: RequestTiming): number =>
  TIMING_PHASES.reduce((sum, phase) => sum + (timing[phase] ?? 0), 0)

/**
 * Fold one check's phases into a bucket's per-phase running averages (the input is not mutated).
 * Each phase keeps its own count, so checks that skip a phase (plain HTTP has no TLS, a reused
 * connection has no DNS/connect) do not drag its average down.
 */
export function applyTiming(
  current: BucketTiming | null | undefined,
  timing: RequestTiming,
): BucketTiming {
  const next: BucketTiming = { ...(current ?? {}) }
  for (const phase of TIMING_PHASES) {
    const value = timing[phase]
    if (value === null) continue
    const prev = next[phase]
    if (!prev || !isPhaseValue(prev.avg) || !isPhaseValue(prev.count) || prev.count === 0) {
      next[phase] = { avg: value, count: 1 }
    } else {
      const count = prev.count + 1
      next[phase] = { avg: (prev.avg * prev.count + value) / count, count }
    }
  }
  return next
}

/** Read a bucket's `extras.timing` back into plain per-phase averages (null when not measured). */
export function bucketTimingAverages(extras: unknown): RequestTiming | null {
  if (!extras || typeof extras !== 'object') return null
  const raw = (extras as { timing?: unknown }).timing
  if (!raw || typeof raw !== 'object') return null
  const averages: Record<string, number | null> = {}
  for (const phase of TIMING_PHASES) {
    const entry = (raw as Record<string, unknown>)[phase] as Partial<TimingAverage> | undefined
    averages[phase] = entry && isPhaseValue(entry.avg) ? entry.avg : null
  }
  return parseRequestTiming(averages)
}
