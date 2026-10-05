/**
 * Polling engine (BullMQ + Redis). Implemented in issue "Polling engine".
 *
 * Responsibilities:
 * - one BullMQ job scheduler per active monitor (`monitor:<id>`, `every: interval * 1000`)
 * - a `checks` worker that runs the monitor type's `check()` and feeds the heartbeat state machine
 * - resync of all schedulers on worker boot
 */
export const QUEUE_NAMES = {
  checks: 'marmot:checks',
  notifications: 'marmot:notifications',
  maintenance: 'marmot:maintenance',
} as const
