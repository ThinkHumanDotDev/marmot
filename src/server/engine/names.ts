/**
 * BullMQ key prefix: every Marmot queue lives under `marmot:<queue>:*` in Redis so one instance can
 * be shared with other applications. (BullMQ forbids `:` inside queue names, hence a prefix.)
 */
export const QUEUE_PREFIX = 'marmot'

/** BullMQ queue names (combined with `QUEUE_PREFIX`). */
export const QUEUE_NAMES = {
  checks: 'checks',
  notifications: 'notifications',
  maintenance: 'maintenance',
} as const

/** Job name of a monitor check on the checks queue. */
export const CHECK_JOB_NAME = 'check' as const

/** Job scheduler id for a monitor. */
export const monitorSchedulerId = (monitorId: string | number) => `monitor:${monitorId}`
