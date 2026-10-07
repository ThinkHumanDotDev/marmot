/**
 * Result of an on-demand check ("Check now" on a saved monitor, "Test" of an unsaved configuration).
 * Shared by the worker (which produces it), the route handlers (which return it as JSON) and the UI
 * (which renders it), so it must stay free of Node-only imports.
 */
import type { AssertionResult } from '@/lib/validation/assertions'

export type OnDemandCheckStatus = 'up' | 'down' | 'pending' | 'maintenance' | 'degraded'

export interface OnDemandCheckTls {
  valid: boolean
  daysRemaining: number | null
  validTo: string | null
  issuer: string | null
  subject: string | null
}

export interface OnDemandCheckHeartbeat {
  id: string
  status: OnDemandCheckStatus
  time: string
  important: boolean
}

export interface OnDemandCheckResult {
  /**
   * Status of this check after `upsideDown` (and, when recorded, the retry rules: a failing check of
   * a monitor with retries left is `pending`).
   */
  status: OnDemandCheckStatus
  /** Whether the check itself succeeded (before `upsideDown`). */
  ok: boolean
  msg: string
  /** Response time in ms, when the type measures one. */
  ping: number | null
  /** When the check started and how long it took, wall clock. */
  startedAt: string
  elapsedMs: number
  /** The outbound address guard refused the target. */
  blocked: boolean
  /** The monitor is in a maintenance window (the check did not run). */
  maintenance: boolean
  /** HTTP status code for HTTP-based types. */
  statusCode: number | null
  tls: OnDemandCheckTls | null
  /** Per-assertion results (HTTP and DNS monitors), `null` when the type has none. */
  assertions: AssertionResult[] | null
  /**
   * Extra, type-specific fields the check reported. Rendered generically so new fields show up
   * without UI changes.
   */
  details: Record<string, unknown>
  /** Whether a heartbeat was stored (`trigger: manual`). */
  recorded: boolean
  heartbeat: OnDemandCheckHeartbeat | null
}

/** Monitor types an on-demand check does not apply to: they are fed from outside, not polled. */
export const ON_DEMAND_UNSUPPORTED_TYPES: readonly string[] = ['push']

/**
 * Types an ad-hoc test of an unsaved configuration does not apply to: they read other saved
 * documents (group children, the manual status) rather than reaching a target.
 */
export const ADHOC_UNSUPPORTED_TYPES: readonly string[] = ['push', 'group', 'manual']

export const supportsCheckNow = (type: string | null | undefined): boolean =>
  !!type && !ON_DEMAND_UNSUPPORTED_TYPES.includes(type)

export const supportsAdhocTest = (type: string | null | undefined): boolean =>
  !!type && !ADHOC_UNSUPPORTED_TYPES.includes(type)
