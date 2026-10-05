import { Redis, type RedisOptions } from 'ioredis'

import { env } from '@/env'

/**
 * Shared ioredis connection factory. BullMQ workers need `maxRetriesPerRequest: null`;
 * socket.io adapters need separate pub/sub connections, so always create fresh clients here.
 */
export function createRedis(options: RedisOptions = {}): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...options,
  })
}
