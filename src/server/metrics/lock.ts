/**
 * Serialisation of pushes to one custom metric (#280). Bucket updates read, merge and write a row,
 * so two pushes that update the same bucket at once would lose one of them. Within a process the
 * pushes of a metric queue behind each other; across processes (web replicas) a Redis lock per
 * metric (`SET NX PX`, released only by its owner) does the same. Without Redis the push still
 * runs: the unique index keeps a bucket from being created twice, only concurrent updates of an
 * existing bucket from two replicas are then unprotected, as before.
 */
import { childLogger } from '@/lib/logger'
import { createRedis } from '@/server/redis'

const log = childLogger('metrics')

/** A push holds the lock at most this long (a crashed holder frees it on expiry). */
export const METRIC_LOCK_TTL_MS = 30_000
/** How long a push waits for another process's push of the same metric. */
const LOCK_WAIT_MS = 10_000
const LOCK_RETRY_MS = 50

type LockClient = Pick<ReturnType<typeof createRedis>, 'set' | 'eval' | 'quit'>

let lockClient: LockClient | null = null
const lockRedis = (): LockClient => {
  lockClient ??= createRedis({ maxRetriesPerRequest: 1, commandTimeout: 1_000 })
  return lockClient
}

/** Closes the lock connection (tests, graceful shutdown). */
export async function closeMetricLocks(): Promise<void> {
  const client = lockClient
  lockClient = null
  if (client) await client.quit().catch(() => undefined)
}

const lockKey = (metricId: string) => `marmot:metric-push:${metricId}`

/** Deletes the key only when it still holds our token (another holder may own it after expiry). */
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/**
 * Run `fn` while holding the cross-process lock of the metric. Exported for tests; pushes go through
 * `withMetricLock`, which queues in the process first.
 */
export async function withRedisMetricLock<T>(
  metricId: string,
  fn: () => Promise<T>,
  options: { client?: LockClient; waitMs?: number } = {},
): Promise<T> {
  const client = options.client ?? lockRedis()
  const key = lockKey(metricId)
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS)
  let held = false
  try {
    for (;;) {
      held = (await client.set(key, token, 'PX', METRIC_LOCK_TTL_MS, 'NX')) === 'OK'
      if (held || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
    if (!held) log.warn({ metricId }, 'metric push lock busy; pushing without it')
  } catch (err) {
    log.warn(
      { metricId, err: err instanceof Error ? err.message : String(err) },
      'metric push lock unavailable; pushing without it',
    )
  }
  try {
    return await fn()
  } finally {
    if (held) await client.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined)
  }
}

const queues = new Map<string, Promise<unknown>>()

/**
 * Run `task` after the pushes of the same metric that are still running in this process, holding
 * the metric's Redis lock against other processes.
 */
export function withMetricLock<T>(metricId: string, task: () => Promise<T>): Promise<T> {
  const run = () => withRedisMetricLock(metricId, task)
  const previous = queues.get(metricId) ?? Promise.resolve()
  const next = previous.then(run, run)
  const settled = next.catch(() => undefined)
  queues.set(metricId, settled)
  void settled.then(() => {
    if (queues.get(metricId) === settled) queues.delete(metricId)
  })
  return next
}
