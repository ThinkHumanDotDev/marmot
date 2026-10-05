import { Redis, type RedisOptions } from 'ioredis'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'

const log = childLogger('redis')

/**
 * Shared ioredis connection factory. BullMQ workers need `maxRetriesPerRequest: null`;
 * socket.io adapters need separate pub/sub connections, so always create fresh clients here.
 */
export function createRedis(options: RedisOptions = {}): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...options,
  })

  // ioredis emits 'error' on every failed reconnect attempt; without a listener Node prints a
  // warning per attempt (and would crash on an unhandled 'error' event). Log once per outage.
  let reportedError: string | null = null
  client.on('error', (err: Error) => {
    if (reportedError !== err.message) {
      reportedError = err.message
      log.error({ err: err.message }, 'redis connection error (will keep retrying)')
    }
  })
  client.on('ready', () => {
    if (reportedError) log.info('redis connection restored')
    reportedError = null
  })

  return client
}
